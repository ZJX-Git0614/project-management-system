import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as XLSX from "@e965/xlsx";
import { XMLBuilder, XMLParser } from "fast-xml-parser";

import type { ProjectGanttTask } from "@/domain/models";
import { addDaysInclusive } from "@/lib/gantt";
import {
  estimatedHoursForDuration,
  isValidGanttDurationDays,
  normalizeGanttDurationDays,
  roundGanttHours,
} from "@/lib/gantt-calendar";

export interface ImportedGanttTask {
  externalId: string;
  databaseId?: string;
  parentExternalId: string | null;
  parentDatabaseId?: string | null;
  ownerMemberId?: string | null;
  ownerName?: string;
  taskCategory: string;
  taskName: string;
  taskDescription: string;
  startDate: string;
  finishDate: string;
  durationDays: number;
  durationMinutes: number;
  durationFormat: number;
  actualStartDate: string;
  actualEndDate: string;
  estimatedWorkHours: number;
  actualWorkHours: number;
  progress: number;
  remark: string;
  predecessorExternalIds: string[];
  predecessorDatabaseIds?: string[];
  predecessorDependencies: ImportedGanttDependency[];
  taskMode: "AUTO" | "MANUAL";
  isMilestone: boolean;
  wbsCode: string;
  outlineNumber: string;
  calendarUid: string;
  constraintType: number | null;
  constraintDate: string;
  baselineStartDate: string;
  baselineFinishDate: string;
  baselineCost: number;
  budgetAtCompletion: number;
  actualCost: number;
  baselines: Record<string, unknown>[];
  sortOrder: number;
}

export interface ImportedGanttDependency {
  predecessorExternalId: string;
  type: number;
  lag: number;
  lagFormat: number;
}

export interface ProjectScheduleMetadata {
  projectSettings: Record<string, unknown>;
  calendars: Record<string, unknown>;
  resources: Record<string, unknown>;
  assignments: Record<string, unknown>;
  taskUidMap: Record<string, string>;
}

export interface GanttImportBundle {
  tasks: ImportedGanttTask[];
  metadata: ProjectScheduleMetadata | null;
}

const MPP_CONVERTER_TIMEOUT_MS = 120_000;
const MPP_CONVERTER_OUTPUT_LIMIT = 16_000;

const readableFile = async (filePath: string) => access(filePath).then(() => true).catch(() => false);

const runMppConverter = async ({
  command,
  args,
  label,
}: {
  command: string;
  args: string[];
  label: string;
}) => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`MPP 文件转换超时（转换器：${label}，等待 ${MPP_CONVERTER_TIMEOUT_MS / 1000} 秒）`));
    }, MPP_CONVERTER_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-MPP_CONVERTER_OUTPUT_LIMIT);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-MPP_CONVERTER_OUTPUT_LIMIT);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 MPP 转换器（${label}）：${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const details = stderr.trim() || stdout.trim() || "转换器未返回错误详情";
        reject(new Error([
          `MPP 文件转换失败（转换器：${label}，退出码：${code ?? "无"}${signal ? `，信号：${signal}` : ""}）`,
          details,
        ].join("\n")));
      }
    });
  });
};

const convertMppFileToXml = async (inputPath: string, outputPath: string) => {
  const converterJar = process.env.MPP_CONVERTER_JAR?.trim() || "/opt/ceastar/mpp-converter.jar";
  if (await readableFile(converterJar)) {
    await runMppConverter({
      command: process.env.JAVA_BIN?.trim() || "java",
      args: ["-jar", converterJar, inputPath, outputPath],
      label: "Java MPXJ",
    });
    return;
  }

  // Local development keeps using the platform package; production Docker uses Java MPXJ above.
  const cliPath = path.join(process.cwd(), "node_modules", "@byteink", "mppjs", "dist", "cli.js");
  await runMppConverter({
    command: process.execPath,
    args: [cliPath, inputPath, outputPath],
    label: "mppjs 原生转换器",
  });
};

const asArray = <T>(value: T | T[] | undefined | null): T[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

const text = (value: unknown) => {
  if (value === undefined || value === null) return "";
  if (typeof value === "object" && value && "#text" in value) {
    return String((value as { "#text": unknown })["#text"] ?? "").trim();
  }
  return String(value).trim();
};

const dateOnly = (value: unknown) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = text(value);
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? "";
};

const durationBetween = (startDate: string, endDate: string) => {
  if (!startDate || !endDate) return 0;
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / 86_400_000) + 1;
};

const numberValue = (value: unknown, fallback = 0) => {
  const parsed = Number(text(value));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseIsoDurationMinutes = (value: unknown) => {
  const raw = text(value);
  const match = raw.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return 0;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  return Math.max(0, Math.round(days * 24 * 60 + hours * 60 + minutes + seconds / 60));
};

const durationMinutesToIso = (minutes: number) => {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const remainder = safeMinutes % 60;
  return `PT${hours}H${remainder}M0S`;
};

const normalizeProgress = (value: unknown) => {
  const parsed = Number(text(value));
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(0, Math.round(parsed)));
};

const orderParentsBeforeChildren = (tasks: ImportedGanttTask[]) => {
  const taskById = new Map(tasks.map((task) => [task.externalId, task]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: ImportedGanttTask[] = [];

  const visit = (task: ImportedGanttTask) => {
    if (visited.has(task.externalId)) return;
    if (visiting.has(task.externalId)) throw new Error(`任务 ${task.externalId} 的父子层级存在循环`);
    visiting.add(task.externalId);
    if (task.parentExternalId) {
      const parent = taskById.get(task.parentExternalId);
      if (parent) visit(parent);
    }
    visiting.delete(task.externalId);
    visited.add(task.externalId);
    ordered.push(task);
  };

  tasks.forEach(visit);
  return ordered;
};

export const parseProjectXmlBundle = (xml: string): GanttImportBundle => {
  const parsed = new XMLParser({ ignoreAttributes: false, trimValues: true }).parse(xml) as Record<string, unknown>;
  const project = (parsed.Project ?? parsed[Object.keys(parsed).find((key) => key.endsWith(":Project")) ?? ""]) as Record<string, unknown> | undefined;
  const taskContainer = project?.Tasks as Record<string, unknown> | undefined;
  const rawTasks = asArray(taskContainer?.Task as Record<string, unknown> | Record<string, unknown>[] | undefined);
  if (rawTasks.length === 0) throw new Error("Project 文件中没有可导入的任务");
  const minutesPerDay = Math.max(1, numberValue(project?.MinutesPerDay, 450));

  const stack: Array<{ level: number; externalId: string }> = [];
  const imported: ImportedGanttTask[] = [];

  rawTasks.forEach((rawTask, index) => {
    const externalId = text(rawTask.UID || rawTask.ID || index + 1);
    const taskName = text(rawTask.Name);
    const outlineLevel = Math.max(0, Number(text(rawTask.OutlineLevel)) || 0);
    const isProjectSummary = externalId === "0" || (outlineLevel === 0 && text(rawTask.Summary) === "1");
    if (!taskName || isProjectSummary) return;

    while (stack.length > 0 && stack[stack.length - 1].level >= outlineLevel) stack.pop();
    const explicitParentId = text(rawTask.ParentTaskUID);
    const parentExternalId = explicitParentId || stack.at(-1)?.externalId || null;
    const startDate = dateOnly(rawTask.Start);
    if (!startDate) throw new Error(`任务“${taskName}”缺少计划开始日期`);
    const finishDate = dateOnly(rawTask.Finish);
    const durationMinutes = parseIsoDurationMinutes(rawTask.Duration);
    const isMilestone = text(rawTask.Milestone) === "1";
    // PMS treats milestones as markers only. Preserve the source duration and dates.
    const durationDays = durationMinutes > 0
      ? normalizeGanttDurationDays(durationMinutes / minutesPerDay)
      : durationBetween(startDate, finishDate);
    const predecessorDependencies = asArray(rawTask.PredecessorLink as Record<string, unknown> | Record<string, unknown>[] | undefined)
      .map((link) => ({
        predecessorExternalId: text(link.PredecessorUID),
        type: Math.round(numberValue(link.Type, 1)),
        lag: Math.round(numberValue(link.LinkLag, 0)),
        lagFormat: Math.round(numberValue(link.LagFormat, 7)),
      }))
      .filter((dependency) => dependency.predecessorExternalId);
    const baselines = asArray(rawTask.Baseline as Record<string, unknown> | Record<string, unknown>[] | undefined);
    const primaryBaseline = baselines.find((baseline) => text(baseline.Number) === "0") ?? baselines[0];
    const baselineCost = numberValue(primaryBaseline?.Cost, 0);

    imported.push({
      externalId,
      parentExternalId,
      ownerName: text(rawTask.Text2),
      taskCategory: "",
      taskName,
      taskDescription: text(rawTask.Notes),
      startDate,
      finishDate: finishDate || (durationDays > 0 ? addDaysInclusive(startDate, durationDays) : ""),
      durationDays,
      durationMinutes,
      durationFormat: Math.round(numberValue(rawTask.DurationFormat, 7)),
      actualStartDate: dateOnly(rawTask.ActualStart),
      actualEndDate: dateOnly(rawTask.ActualFinish),
      estimatedWorkHours: parseIsoDurationMinutes(rawTask.Work) / 60,
      actualWorkHours: parseIsoDurationMinutes(rawTask.ActualWork) / 60,
      progress: normalizeProgress(rawTask.PercentComplete),
      remark: text(rawTask.Text3),
      predecessorExternalIds: predecessorDependencies.map((dependency) => dependency.predecessorExternalId),
      predecessorDependencies,
      taskMode: text(rawTask.Manual) === "1" ? "MANUAL" : "AUTO",
      isMilestone,
      wbsCode: text(rawTask.WBS),
      outlineNumber: text(rawTask.OutlineNumber),
      calendarUid: text(rawTask.CalendarUID),
      constraintType: text(rawTask.ConstraintType) ? Math.round(numberValue(rawTask.ConstraintType)) : null,
      constraintDate: dateOnly(rawTask.ConstraintDate),
      baselineStartDate: dateOnly(primaryBaseline?.Start),
      baselineFinishDate: dateOnly(primaryBaseline?.Finish),
      baselineCost,
      budgetAtCompletion: baselineCost || numberValue(rawTask.Cost, 0),
      actualCost: numberValue(rawTask.ActualCost, 0),
      baselines,
      sortOrder: imported.length + 1,
    });
    stack.push({ level: outlineLevel, externalId });
  });

  const byId = new Map(imported.map((task) => [task.externalId, task]));
  const rootName = (task: ImportedGanttTask) => {
    let current = task;
    while (current.parentExternalId && byId.has(current.parentExternalId)) {
      current = byId.get(current.parentExternalId)!;
    }
    return current === task ? "" : current.taskName;
  };

  const settings = Object.fromEntries(Object.entries(project ?? {}).filter(([key, value]) => (
    !["Tasks", "Calendars", "Resources", "Assignments"].includes(key)
      && (value === null || ["string", "number", "boolean"].includes(typeof value))
  )));

  return {
    tasks: orderParentsBeforeChildren(imported.map((task) => ({
      ...task,
      taskCategory: text((rawTasks.find((raw) => text(raw.UID || raw.ID) === task.externalId) ?? {}).Text1) || rootName(task),
    }))),
    metadata: {
      projectSettings: settings,
      calendars: (project?.Calendars as Record<string, unknown> | undefined) ?? {},
      resources: (project?.Resources as Record<string, unknown> | undefined) ?? {},
      assignments: (project?.Assignments as Record<string, unknown> | undefined) ?? {},
      taskUidMap: {},
    },
  };
};

export const parseProjectXml = (xml: string): ImportedGanttTask[] => parseProjectXmlBundle(xml).tasks;

const excelValue = (row: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && text(row[key])) return row[key];
  }
  return "";
};

export const parseGanttExcel = (buffer: Buffer, fallbackStartDate = ""): ImportedGanttTask[] => {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("Excel 文件中没有工作表");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  const imported = rows.map((row, index) => {
    const taskName = text(excelValue(row, "任务名称", "Task Name", "Name"));
    const startDate = dateOnly(excelValue(row, "计划开始", "Start", "Start Date")) || dateOnly(fallbackStartDate);
    if (!taskName) throw new Error(`Excel 第 ${index + 2} 行缺少任务名称`);
    if (!startDate) throw new Error(`Excel 第 ${index + 2} 行缺少计划开始日期`);
    const finishDate = dateOnly(excelValue(row, "计划完成", "Finish", "Finish Date"));
    const explicitDurationText = text(excelValue(row, "工期(天)", "工期", "Duration Days"));
    const explicitDuration = explicitDurationText ? Number(explicitDurationText) : Number.NaN;
    const durationDays = isValidGanttDurationDays(explicitDuration)
      ? normalizeGanttDurationDays(explicitDuration)
      : durationBetween(startDate, finishDate);
    const durationMinutesFromFile = Math.max(
      0,
      Math.round(numberValue(excelValue(row, "工期(分钟)", "Duration Minutes"), 0)),
    );
    const predecessorValue = text(excelValue(row, "紧前任务ID", "Predecessors", "Predecessor"));
    const predecessorDatabaseValue = text(excelValue(row, "系统紧前任务键", "System Predecessor Keys"));

    return {
      externalId: text(excelValue(row, "任务ID", "Task ID", "ID")) || `row-${index + 1}`,
      databaseId: text(excelValue(row, "系统任务键", "System Task Key")),
      parentExternalId: text(excelValue(row, "父任务ID", "Parent Task ID", "Parent ID")) || null,
      parentDatabaseId: text(excelValue(row, "系统父任务键", "System Parent Task Key")) || null,
      ownerMemberId: text(excelValue(row, "系统负责人键", "System Owner Key")) || null,
      ownerName: text(excelValue(row, "负责人", "Owner", "Resource Name")),
      taskCategory: text(excelValue(row, "任务类别", "Category")),
      taskName,
      taskDescription: text(excelValue(row, "任务描述", "Task Description", "Description", "Notes")),
      startDate,
      finishDate: finishDate || (durationDays > 0 ? addDaysInclusive(startDate, durationDays) : ""),
      durationDays,
      durationMinutes: durationMinutesFromFile || Math.round(durationDays * 450),
      durationFormat: Math.round(numberValue(excelValue(row, "工期格式", "Duration Format"), 7)),
      actualStartDate: dateOnly(excelValue(row, "实际开始", "Actual Start")),
      actualEndDate: dateOnly(excelValue(row, "实际完成", "Actual Finish")),
      estimatedWorkHours: Math.max(0, numberValue(excelValue(row, "预计工时(小时)", "预计工时", "Planned Work Hours", "Work Hours"))),
      actualWorkHours: Math.max(0, numberValue(excelValue(row, "实际工时(小时)", "实际工时", "Actual Work Hours"))),
      progress: normalizeProgress(excelValue(row, "当前进度(%)", "当前进度", "Progress")),
      remark: text(excelValue(row, "备注", "Remark", "Remarks", "Note")),
      predecessorExternalIds: predecessorValue.split(/[,，;；\s]+/).filter(Boolean),
      predecessorDatabaseIds: predecessorDatabaseValue.split(/[,，;；\s]+/).filter(Boolean),
      predecessorDependencies: predecessorValue.split(/[,，;；\s]+/).filter(Boolean).map((predecessorExternalId) => ({
        predecessorExternalId,
        type: 1,
        lag: 0,
        lagFormat: 7,
      })),
      taskMode: text(excelValue(row, "任务模式", "Task Mode")).toUpperCase() === "MANUAL" ? "MANUAL" : "AUTO",
      isMilestone: ["1", "是", "true", "TRUE"].includes(text(excelValue(row, "里程碑", "Milestone"))),
      wbsCode: text(excelValue(row, "WBS", "WBS Code")),
      outlineNumber: text(excelValue(row, "大纲编号", "Outline Number")),
      calendarUid: text(excelValue(row, "日历UID", "Calendar UID")),
      constraintType: text(excelValue(row, "约束类型", "Constraint Type"))
        ? Math.round(numberValue(excelValue(row, "约束类型", "Constraint Type")))
        : null,
      constraintDate: dateOnly(excelValue(row, "约束日期", "Constraint Date")),
      baselineStartDate: dateOnly(excelValue(row, "基线开始", "Baseline Start")),
      baselineFinishDate: dateOnly(excelValue(row, "基线完成", "Baseline Finish")),
      baselineCost: numberValue(excelValue(row, "基线成本", "Baseline Cost")),
      budgetAtCompletion: numberValue(excelValue(row, "完工预算(BAC)", "BAC", "Budget at Completion")),
      actualCost: numberValue(excelValue(row, "实际成本(AC)", "AC", "Actual Cost")),
      baselines: [],
      sortOrder: index + 1,
    } satisfies ImportedGanttTask;
  });

  if (imported.length === 0) throw new Error("Excel 文件中没有可导入的任务");
  return orderParentsBeforeChildren(imported);
};

export const parseGanttImportFile = async (
  fileName: string,
  buffer: Buffer,
  options: { fallbackStartDate?: string } = {},
): Promise<GanttImportBundle> => {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".xlsx" || extension === ".xls") return { tasks: parseGanttExcel(buffer, options.fallbackStartDate), metadata: null };
  if (extension === ".xml") return parseProjectXmlBundle(buffer.toString("utf8"));
  if (extension !== ".mpp") throw new Error("仅支持 .mpp、.xml、.xls 或 .xlsx 文件");

  const directory = await mkdtemp(path.join(tmpdir(), "pms-mpp-"));
  const inputPath = path.join(directory, "input.mpp");
  const outputPath = path.join(directory, "output.xml");
  try {
    await writeFile(inputPath, buffer);
    await convertMppFileToXml(inputPath, outputPath);
    return parseProjectXmlBundle(await readFile(outputPath, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const taskDepth = (task: ProjectGanttTask, taskById: Map<string, ProjectGanttTask>) => {
  let depth = 1;
  let current = task;
  const visited = new Set<string>();
  while (current.parentId && taskById.has(current.parentId) && !visited.has(current.parentId)) {
    visited.add(current.parentId);
    current = taskById.get(current.parentId)!;
    depth += 1;
  }
  return depth;
};

const GANTT_VISIBLE_HEADERS = [
  "任务ID", "父任务ID", "任务类别", "任务名称", "任务描述", "负责人", "计划开始", "计划完成", "工期(天)",
  "工期(分钟)", "任务模式", "里程碑", "WBS", "实际开始", "实际完成", "预计工时(小时)", "实际工时(小时)",
  "当前进度(%)", "紧前任务ID", "基线开始", "基线完成", "基线成本", "完工预算(BAC)", "实际成本(AC)", "备注",
] as const;

const GANTT_SYSTEM_HEADERS = ["系统任务键", "系统父任务键", "系统紧前任务键", "系统负责人键"] as const;
const GANTT_EXPORT_HEADERS = [...GANTT_VISIBLE_HEADERS, ...GANTT_SYSTEM_HEADERS];

const GANTT_COLUMN_WIDTHS: Record<string, number> = {
  任务ID: 16,
  父任务ID: 16,
  任务类别: 30,
  任务名称: 32,
  任务描述: 42,
  负责人: 16,
  计划开始: 13,
  计划完成: 13,
  "工期(天)": 10,
  "工期(分钟)": 12,
  任务模式: 11,
  里程碑: 9,
  WBS: 15,
  实际开始: 13,
  实际完成: 13,
  "预计工时(小时)": 16,
  "实际工时(小时)": 16,
  "当前进度(%)": 13,
  紧前任务ID: 24,
  基线开始: 13,
  基线完成: 13,
  基线成本: 14,
  "完工预算(BAC)": 16,
  "实际成本(AC)": 16,
  备注: 32,
};

const GANTT_DATE_HEADERS = new Set(["计划开始", "计划完成", "实际开始", "实际完成", "基线开始", "基线完成"]);
const GANTT_INTEGER_HEADERS = new Set(["工期(分钟)", "当前进度(%)"]);
const GANTT_DECIMAL_HEADERS = new Set(["工期(天)", "预计工时(小时)", "实际工时(小时)"]);
const GANTT_COST_HEADERS = new Set(["基线成本", "完工预算(BAC)", "实际成本(AC)"]);
const GANTT_CENTER_HEADERS = new Set([
  "计划开始", "计划完成", "工期(天)", "工期(分钟)", "任务模式", "里程碑", "WBS", "实际开始", "实际完成",
  "预计工时(小时)", "实际工时(小时)", "当前进度(%)", "基线开始", "基线完成", "基线成本", "完工预算(BAC)",
  "实际成本(AC)",
]);

const GANTT_LEVEL_STYLES = [
  { fill: "B4C7E7", font: "17365D", bold: true },
  { fill: "D9EAF7", font: "1F4E78", bold: true },
  { fill: "EEF4FA", font: "315A7D", bold: true },
  { fill: "F7F9FC", font: "445B70", bold: false },
] as const;

const GANTT_STYLE_VARIANTS = ["text", "wrapped", "taskName", "center", "integer", "decimal", "cost", "date"] as const;
type GanttStyleVariant = typeof GANTT_STYLE_VARIANTS[number];

const xmlColor = (rgb: string) => `<color rgb="FF${rgb}"/>`;

const ganttStyleVariant = (header: string): GanttStyleVariant => {
  if (header === "任务名称") return "taskName";
  if (header === "任务类别" || header === "任务描述" || header === "备注") return "wrapped";
  if (GANTT_DATE_HEADERS.has(header)) return "date";
  if (GANTT_INTEGER_HEADERS.has(header)) return "integer";
  if (GANTT_DECIMAL_HEADERS.has(header)) return "decimal";
  if (GANTT_COST_HEADERS.has(header)) return "cost";
  if (GANTT_CENTER_HEADERS.has(header)) return "center";
  return "text";
};

const ganttStyleId = (depth: number, header: string) => {
  const levelIndex = Math.min(GANTT_LEVEL_STYLES.length, Math.max(1, depth)) - 1;
  const variantIndex = GANTT_STYLE_VARIANTS.indexOf(ganttStyleVariant(header));
  return 2 + levelIndex * GANTT_STYLE_VARIANTS.length + variantIndex;
};

const buildGanttStylesXml = () => {
  const fonts = [
    '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>',
    `<font><b/><sz val="10"/>${xmlColor("FFFFFF")}<name val="Microsoft YaHei"/><family val="2"/></font>`,
    ...GANTT_LEVEL_STYLES.map((style) => (
      `<font>${style.bold ? "<b/>" : ""}<sz val="10"/>${xmlColor(style.font)}<name val="Microsoft YaHei"/><family val="2"/></font>`
    )),
  ];
  const fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill>',
    ...GANTT_LEVEL_STYLES.map((style) => (
      `<fill><patternFill patternType="solid"><fgColor rgb="FF${style.fill}"/><bgColor indexed="64"/></patternFill></fill>`
    )),
  ];
  const borders = [
    "<border><left/><right/><top/><bottom/><diagonal/></border>",
    '<border><left style="thin"><color rgb="FF557A9E"/></left><right style="thin"><color rgb="FF557A9E"/></right><top style="medium"><color rgb="FF163A5C"/></top><bottom style="medium"><color rgb="FF163A5C"/></bottom><diagonal/></border>',
    '<border><left/><right/><top style="thin"><color rgb="FFD9E2F3"/></top><bottom style="thin"><color rgb="FFD9E2F3"/></bottom><diagonal/></border>',
  ];
  const cellXfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>',
  ];

  GANTT_LEVEL_STYLES.forEach((_style, levelIndex) => {
    GANTT_STYLE_VARIANTS.forEach((variant) => {
      const numberFormatId = variant === "integer" ? 1 : variant === "decimal" ? 2 : variant === "cost" ? 4 : variant === "date" ? 164 : 0;
      const horizontal = variant === "cost" ? "right" : ["center", "integer", "decimal", "date"].includes(variant) ? "center" : "left";
      const wrapText = variant === "wrapped" || variant === "taskName";
      const indent = variant === "taskName" && levelIndex > 0 ? ` indent="${levelIndex}"` : "";
      cellXfs.push([
        `<xf numFmtId="${numberFormatId}" fontId="${levelIndex + 2}" fillId="${levelIndex + 3}" borderId="2" xfId="0"`,
        ` applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"${numberFormatId ? ' applyNumberFormat="1"' : ""}>`,
        `<alignment horizontal="${horizontal}" vertical="center"${wrapText ? ' wrapText="1"' : ""}${indent}/></xf>`,
      ].join(""));
    });
  });

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>',
    `<fonts count="${fonts.length}">${fonts.join("")}</fonts>`,
    `<fills count="${fills.length}">${fills.join("")}</fills>`,
    `<borders count="${borders.length}">${borders.join("")}</borders>`,
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    `<cellXfs count="${cellXfs.length}">${cellXfs.join("")}</cellXfs>`,
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
    '<dxfs count="0"/>',
    '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>',
    "</styleSheet>",
  ].join("");
};

const styleGanttWorksheetXml = (xml: string, headers: readonly string[], depths: number[]) => {
  const headerByColumn = new Map(headers.map((header, index) => [XLSX.utils.encode_col(index), header]));
  let styled = xml.replace(/<c r="([A-Z]+)(\d+)"([^>]*)>/g, (match, column: string, rowText: string, attributes: string) => {
    const row = Number(rowText);
    const header = headerByColumn.get(column);
    if (!header) return match;
    const styleId = row === 1 ? 1 : ganttStyleId(depths[row - 2] ?? GANTT_LEVEL_STYLES.length, header);
    const cleanAttributes = attributes.replace(/\s+s="[^"]*"/g, "");
    return `<c r="${column}${row}"${cleanAttributes} s="${styleId}">`;
  });
  styled = styled.replace(
    /<sheetViews><sheetView workbookViewId="0"\/><\/sheetViews>/,
    '<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane xSplit="4" ySplit="1" topLeftCell="E2" activePane="bottomRight" state="frozen"/><selection pane="topRight" activeCell="E1" sqref="E1"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/><selection pane="bottomRight"/></sheetView></sheetViews>',
  );
  const validationXml = '<dataValidations count="2"><dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="K2:K1048576"><formula1>"AUTO,MANUAL"</formula1></dataValidation><dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="L2:L1048576"><formula1>"是,否"</formula1></dataValidation></dataValidations>';
  return styled.replace(/(<pageMargins\b)/, `${validationXml}$1`);
};

const styleGanttReportWorksheetXml = (xml: string) => {
  let styled = xml.replace(/<c r="([A-Z]+)(\d+)"([^>]*)>/g, (match, column: string, rowText: string, attributes: string) => {
    const row = Number(rowText);
    const styleId = row === 1 || row === 6 || row === 16 ? 1 : row % 2 === 0 ? 10 : 18;
    const cleanAttributes = attributes.replace(/\s+s="[^"]*"/g, "");
    return `<c r="${column}${row}"${cleanAttributes} s="${styleId}">`;
  });
  styled = styled.replace(
    /<sheetViews><sheetView workbookViewId="0"\/><\/sheetViews>/,
    '<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="6" topLeftCell="A7" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A7" sqref="A7"/></sheetView></sheetViews>',
  );
  return styled;
};

const applyGanttWorkbookStyle = (
  buffer: Buffer,
  headers: readonly string[],
  depths: number[],
  hasProgressReport = false,
) => {
  const archive = XLSX.CFB.read(buffer, { type: "buffer" });
  const stylesFile = XLSX.CFB.find(archive, "Root Entry/xl/styles.xml");
  const worksheetFile = XLSX.CFB.find(archive, "Root Entry/xl/worksheets/sheet1.xml");
  if (!stylesFile?.content || !worksheetFile?.content) throw new Error("无法写入甘特 Excel 样式");
  stylesFile.content = Buffer.from(buildGanttStylesXml(), "utf8");
  worksheetFile.content = Buffer.from(
    styleGanttWorksheetXml(Buffer.from(worksheetFile.content).toString("utf8"), headers, depths),
    "utf8",
  );
  if (hasProgressReport) {
    const reportFile = XLSX.CFB.find(archive, "Root Entry/xl/worksheets/sheet2.xml");
    if (!reportFile?.content) throw new Error("无法写入进度总结 Excel 样式");
    reportFile.content = Buffer.from(
      styleGanttReportWorksheetXml(Buffer.from(reportFile.content).toString("utf8")),
      "utf8",
    );
  }
  return Buffer.from(XLSX.CFB.write(archive, { type: "buffer", fileType: "zip", compression: true }));
};

const applyGanttWorksheetStyle = (
  worksheet: XLSX.WorkSheet,
  headers: readonly string[],
  depths: number[],
) => {
  const lastVisibleColumn = XLSX.utils.encode_col(GANTT_VISIBLE_HEADERS.length - 1);
  worksheet["!cols"] = headers.map((header) => (
    header.startsWith("系统")
      ? { hidden: true, wch: 2 }
      : { wch: GANTT_COLUMN_WIDTHS[header] ?? Math.max(12, Math.min(24, header.length * 2 + 2)) }
  ));
  worksheet["!rows"] = [
    { hpt: 30 },
    ...depths.map((depth, index) => {
      const description = worksheet[`E${index + 2}`]?.v;
      const remark = worksheet[`Y${index + 2}`]?.v;
      const longestText = Math.max(String(description ?? "").length, String(remark ?? "").length);
      return { hpt: longestText > 80 ? 42 : longestText > 40 ? 30 : 22, level: Math.min(7, Math.max(0, depth - 1)) };
    }),
  ];
  worksheet["!autofilter"] = { ref: `A1:${lastVisibleColumn}${Math.max(1, depths.length + 1)}` };
  worksheet["!freeze"] = { xSplit: 4, ySplit: 1 };
  worksheet["!margins"] = { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
};

export type GanttExcelProgressReport = {
  total: number;
  completed: number;
  inProgress: number;
  notStarted: number;
  overdue: number;
  averageProgress: number;
  categoryBreakdown: Array<{ category: string; total: number; averageProgress: number }>;
  summary: string;
};

export type GanttExcelOptions = {
  report?: GanttExcelProgressReport;
  reportFilters?: string[];
  generatedAt?: Date;
};

const progressBar = (ratio: number, width = 32) => {
  const normalized = Math.max(0, Math.min(1, ratio));
  return "█".repeat(Math.round(normalized * width));
};

const buildGanttProgressReportWorksheet = (options: Required<Pick<GanttExcelOptions, "report">> & GanttExcelOptions) => {
  const { report } = options;
  const total = Math.max(1, report.total);
  const rows: unknown[][] = [
    ["任务进度总结报告", "", "", "", "", ""],
    ["生成时间", (options.generatedAt ?? new Date()).toISOString().replace("T", " ").slice(0, 19)],
    ["筛选条件", options.reportFilters?.join("；") || "无额外筛选"],
    ["报告摘要", report.summary],
    [],
    ["进度指标", "数值", "占比", "可视化"],
    ["任务总数", report.total, 1, progressBar(1)],
    ["已完成", report.completed, report.completed / total, progressBar(report.completed / total)],
    ["进行中", report.inProgress, report.inProgress / total, progressBar(report.inProgress / total)],
    ["未开始", report.notStarted, report.notStarted / total, progressBar(report.notStarted / total)],
    ["逾期未完成", report.overdue, report.overdue / total, progressBar(report.overdue / total)],
    ["平均进度", report.averageProgress, report.averageProgress / 100, progressBar(report.averageProgress / 100)],
    [],
    [],
    [],
    ["任务类别", "任务数", "占比", "平均进度(%)", "任务量", "进度"],
    ...report.categoryBreakdown.map((item) => [
      item.category,
      item.total,
      item.total / total,
      item.averageProgress,
      progressBar(item.total / total, 24),
      progressBar(item.averageProgress / 100, 24),
    ]),
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet["!cols"] = [{ wch: 32 }, { wch: 18 }, { wch: 14 }, { wch: 38 }, { wch: 28 }, { wch: 28 }];
  worksheet["!rows"] = rows.map((_row, index) => ({ hpt: index === 0 ? 32 : index === 3 ? 36 : 23 }));
  worksheet["!merges"] = [XLSX.utils.decode_range("A1:F1"), XLSX.utils.decode_range("B3:F3"), XLSX.utils.decode_range("B4:F4")];
  worksheet["!autofilter"] = { ref: `A16:F${Math.max(16, rows.length)}` };
  return worksheet;
};

export const buildGanttExcel = (tasks: ProjectGanttTask[], options: GanttExcelOptions = {}) => {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const rows = tasks.map((task) => ({
    任务ID: task.taskCode,
    父任务ID: task.parentId ? taskById.get(task.parentId)?.taskCode ?? "" : "",
    任务类别: task.taskCategory,
    任务名称: task.taskName,
    任务描述: task.taskDescription?.trim() || "无",
    负责人: task.ownerMember?.personName ?? "",
    计划开始: task.startDate,
    计划完成: task.finishDate || (task.durationDays > 0 ? addDaysInclusive(task.startDate, task.durationDays) : ""),
    "工期(天)": task.durationDays > 0 ? task.durationDays : "",
    "工期(分钟)": task.durationMinutes && task.durationMinutes > 0 ? task.durationMinutes : "",
    任务模式: task.taskMode ?? "AUTO",
    里程碑: task.isMilestone ? "是" : "否",
    WBS: task.wbsCode || task.taskCode.replace(/^Task/, ""),
    实际开始: task.actualStartDate,
    实际完成: task.actualEndDate,
    "预计工时(小时)": task.durationDays > 0 ? estimatedHoursForDuration(task.durationDays) : "",
    "实际工时(小时)": task.actualWorkHours && task.actualWorkHours > 0 ? roundGanttHours(task.actualWorkHours) : "",
    "当前进度(%)": task.progress,
    紧前任务ID: task.predecessorTaskIds?.map((id) => taskById.get(id)?.taskCode).filter(Boolean).join(",") || task.predecessorTask,
    基线开始: task.baselineStartDate ?? "",
    基线完成: task.baselineFinishDate ?? "",
    基线成本: task.baselineCost ?? 0,
    "完工预算(BAC)": task.budgetAtCompletion ?? 0,
    "实际成本(AC)": task.actualCost ?? 0,
    备注: task.remark ?? "",
    系统任务键: task.id,
    系统父任务键: task.parentId ?? "",
    系统紧前任务键: task.predecessorTaskIds?.join(",") ?? "",
    系统负责人键: task.ownerMemberId ?? "",
  }));
  const worksheet = XLSX.utils.json_to_sheet(rows, { header: GANTT_EXPORT_HEADERS });
  const depths = tasks.map((task) => taskDepth(task, taskById));
  applyGanttWorksheetStyle(worksheet, GANTT_EXPORT_HEADERS, depths);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "项目进度");
  if (options.report) {
    XLSX.utils.book_append_sheet(workbook, buildGanttProgressReportWorksheet({ ...options, report: options.report }), "进度总结");
  }
  const buffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  return applyGanttWorkbookStyle(buffer, GANTT_EXPORT_HEADERS, depths, Boolean(options.report));
};

export const buildGanttExcelTemplate = () => {
  const headers = [...GANTT_VISIBLE_HEADERS];
  const worksheet = XLSX.utils.aoa_to_sheet([headers]);
  applyGanttWorksheetStyle(worksheet, headers, []);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "项目进度导入模板");
  const buffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  return applyGanttWorkbookStyle(buffer, headers, []);
};

const isoDateTime = (date: string) => `${date}T08:00:00`;

const hasObjectValues = (value: Record<string, unknown> | undefined) => Boolean(value && Object.keys(value).length > 0);

const remapAssignments = (
  assignments: Record<string, unknown>,
  metadataTaskUidMap: Record<string, string>,
  uidByTaskId: Map<string, number>,
) => {
  const rawAssignments = asArray((assignments as { Assignment?: Record<string, unknown> | Record<string, unknown>[] }).Assignment);
  const remapped = rawAssignments.flatMap((assignment) => {
    const externalTaskUid = text(assignment.TaskUID);
    const databaseTaskId = metadataTaskUidMap[externalTaskUid];
    const taskUid = databaseTaskId ? uidByTaskId.get(databaseTaskId) : undefined;
    if (!taskUid) return [];
    return [{ ...assignment, TaskUID: taskUid }];
  });
  return remapped.length > 0 ? { Assignment: remapped } : {};
};

export const buildProjectXml = (
  projectName: string,
  tasks: ProjectGanttTask[],
  metadata?: ProjectScheduleMetadata | null,
) => {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const usedUids = new Set<number>();
  let nextUid = 1;
  const uidByTaskId = new Map(tasks.map((task) => {
    const externalUid = Number(task.externalUid);
    let uid = Number.isInteger(externalUid) && externalUid > 0 && !usedUids.has(externalUid) ? externalUid : 0;
    while (!uid || usedUids.has(uid)) {
      while (usedUids.has(nextUid)) nextUid += 1;
      uid = nextUid++;
    }
    usedUids.add(uid);
    return [task.id, uid];
  }));
  const uidByTaskName = new Map(tasks.filter((task) => task.taskName).map((task) => [task.taskName, uidByTaskId.get(task.id)!]));
  const hasChildren = new Set(tasks.map((task) => task.parentId).filter(Boolean));
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "");

  const projectTasks = tasks.map((task, index) => {
    const depth = taskDepth(task, taskById);
    const predecessorLinks = task.predecessorDependencies && task.predecessorDependencies.length > 0
      ? task.predecessorDependencies.flatMap((dependency) => {
        const uid = uidByTaskId.get(dependency.predecessorTaskId);
        return uid ? [{
          PredecessorUID: uid,
          Type: dependency.type,
          CrossProject: 0,
          LinkLag: dependency.lag,
          LagFormat: dependency.lagFormat,
        }] : [];
      })
      : task.predecessorTask
        .split(/[,，;；]+/)
        .map((name) => uidByTaskName.get(name.trim()))
        .filter((uid): uid is number => Boolean(uid))
        .map((uid) => ({ PredecessorUID: uid, Type: 1, CrossProject: 0, LinkLag: 0, LagFormat: 7 }));
    const durationMinutes = task.durationMinutes || Math.round(task.durationDays * 450);
    const finishDate = task.finishDate || addDaysInclusive(task.startDate, task.durationDays) || task.startDate;
    const baselines = Array.isArray(task.baselines) && task.baselines.length > 0
      ? task.baselines
      : (task.baselineStartDate || task.baselineFinishDate || task.baselineCost)
        ? [{
          Number: 0,
          Start: task.baselineStartDate ? isoDateTime(task.baselineStartDate) : undefined,
          Finish: task.baselineFinishDate ? isoDateTime(task.baselineFinishDate) : undefined,
          Cost: task.baselineCost ?? 0,
        }]
        : [];

    return {
      UID: uidByTaskId.get(task.id),
      ID: index + 1,
      Name: task.taskName || task.taskCode,
      Type: 1,
      IsNull: 0,
      CreateDate: now,
      WBS: task.wbsCode || task.taskCode.replace(/^Task/, ""),
      OutlineNumber: task.outlineNumber || task.taskCode.replace(/^Task/, ""),
      OutlineLevel: depth,
      Manual: task.taskMode === "MANUAL" ? 1 : 0,
      Text1: task.taskCategory,
      Text2: task.ownerMember?.personName ?? "",
      Notes: task.taskDescription?.trim() || "无",
      Text3: task.remark ?? "",
      Priority: 500,
      Start: isoDateTime(task.startDate),
      Finish: isoDateTime(finishDate),
      Duration: durationMinutesToIso(durationMinutes),
      DurationFormat: task.durationFormat ?? 7,
      Work: durationMinutesToIso(Math.round(estimatedHoursForDuration(task.durationDays) * 60)),
      ActualWork: durationMinutesToIso(Math.round(roundGanttHours(task.actualWorkHours ?? 0) * 60)),
      ResumeValid: 0,
      EffortDriven: 0,
      Recurring: 0,
      OverAllocated: 0,
      Estimated: 0,
      Milestone: task.isMilestone ? 1 : 0,
      Summary: hasChildren.has(task.id) ? 1 : 0,
      Critical: 0,
      PercentComplete: task.progress,
      PercentWorkComplete: task.progress,
      Cost: task.budgetAtCompletion ?? 0,
      ActualCost: task.actualCost ?? 0,
      ...(task.calendarUid ? { CalendarUID: Number(task.calendarUid) || task.calendarUid } : {}),
      ...(task.constraintType !== null && task.constraintType !== undefined ? { ConstraintType: task.constraintType } : {}),
      ...(task.constraintDate ? { ConstraintDate: isoDateTime(task.constraintDate) } : {}),
      ...(task.actualStartDate ? { ActualStart: isoDateTime(task.actualStartDate) } : {}),
      ...(task.actualEndDate ? { ActualFinish: isoDateTime(task.actualEndDate) } : {}),
      ...(predecessorLinks.length > 0 ? { PredecessorLink: predecessorLinks } : {}),
      ...(baselines.length > 0 ? { Baseline: baselines } : {}),
    };
  });

  const finishDate = tasks.length > 0
    ? tasks.reduce((latest, task) => {
      const finish = task.finishDate || addDaysInclusive(task.startDate, task.durationDays);
      return finish > latest ? finish : latest;
    }, tasks[0].startDate)
    : "";
  const remappedAssignments = metadata
    ? remapAssignments(metadata.assignments, metadata.taskUidMap, uidByTaskId)
    : {};

  const document = {
    Project: {
      "@_xmlns": "http://schemas.microsoft.com/project",
      SaveVersion: 14,
      CreationDate: now,
      ScheduleFromStart: 1,
      FYStartDate: 1,
      CriticalSlackLimit: 0,
      CurrencyDigits: 2,
      CurrencySymbol: "¥",
      CurrencyCode: "CNY",
      ...(metadata?.projectSettings ?? {}),
      MinutesPerDay: 450,
      MinutesPerWeek: 2250,
      DaysPerMonth: 20,
      DefaultStartTime: "08:00:00",
      DefaultFinishTime: "17:00:00",
      CalendarUID: 1,
      Name: projectName,
      Title: projectName,
      LastSaved: now,
      StartDate: tasks[0] ? isoDateTime(tasks[0].startDate) : now,
      FinishDate: finishDate ? isoDateTime(finishDate) : now,
      ...(hasObjectValues(metadata?.calendars) ? { Calendars: metadata!.calendars } : {}),
      ...(hasObjectValues(metadata?.resources) ? { Resources: metadata!.resources } : {}),
      Tasks: { Task: projectTasks },
      ...(hasObjectValues(remappedAssignments) ? { Assignments: remappedAssignments } : {}),
    },
  };

  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${new XMLBuilder({ ignoreAttributes: false, format: true }).build(document)}`, "utf8");
};

export const convertProjectXmlToMpp = async (xml: Buffer) => {
  const serviceUrl = process.env.PROJECT_MPP_EXPORT_SERVICE_URL?.trim();
  if (!serviceUrl) throw new Error("尚未配置 MPP 导出转换服务，请先导出 Project XML 并在 Microsoft Project 中另存为 MPP");
  const response = await fetch(serviceUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml",
      ...(process.env.PROJECT_MPP_EXPORT_SERVICE_TOKEN
        ? { Authorization: `Bearer ${process.env.PROJECT_MPP_EXPORT_SERVICE_TOKEN}` }
        : {}),
    },
    body: new Uint8Array(xml),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`MPP 转换服务返回 ${response.status}`);
  const output = Buffer.from(await response.arrayBuffer());
  const compoundFileSignature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (output.length < compoundFileSignature.length || !output.subarray(0, 8).equals(compoundFileSignature)) {
    throw new Error("MPP 转换服务未返回有效的 Microsoft Project 文件");
  }
  return output;
};

const mppExportServiceAvailable = async () => {
  const serviceUrl = process.env.PROJECT_MPP_EXPORT_SERVICE_URL?.trim();
  if (!serviceUrl) return false;
  const healthUrl = process.env.PROJECT_MPP_EXPORT_SERVICE_HEALTH_URL?.trim();
  if (!healthUrl) return true;
  try {
    const response = await fetch(healthUrl, {
      headers: process.env.PROJECT_MPP_EXPORT_SERVICE_TOKEN
        ? { Authorization: `Bearer ${process.env.PROJECT_MPP_EXPORT_SERVICE_TOKEN}` }
        : {},
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

export const ganttTransferCapabilities = async () => ({
  excelImport: true,
  excelExport: true,
  projectXmlImport: true,
  projectXmlExport: true,
  mppImport: true,
  mppExport: await mppExportServiceAvailable(),
});
