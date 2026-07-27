import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as XLSX from "@e965/xlsx";
import { XMLBuilder, XMLParser } from "fast-xml-parser";

import type { ProjectGanttTask } from "@/domain/models";
import { addDaysInclusive } from "@/lib/gantt";

export interface ImportedGanttTask {
  externalId: string;
  parentExternalId: string | null;
  taskCategory: string;
  taskName: string;
  startDate: string;
  finishDate: string;
  durationDays: number;
  durationMinutes: number;
  durationFormat: number;
  actualStartDate: string;
  actualEndDate: string;
  progress: number;
  predecessorExternalIds: string[];
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

const convertMppFileToXml = async (inputPath: string, outputPath: string) => {
  // Static require.resolve calls are converted to numeric Webpack module IDs in production builds.
  const cliPath = path.join(process.cwd(), "node_modules", "@byteink", "mppjs", "dist", "cli.js");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, inputPath, outputPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("MPP 文件转换超时"));
    }, 120_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `MPP 文件转换失败（退出码 ${code}）`));
    });
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
  if (!startDate || !endDate) return 1;
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
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
  const minutesPerDay = Math.max(1, numberValue(project?.MinutesPerDay, 480));

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
      taskCategory: "",
      taskName,
      startDate,
      finishDate: finishDate || startDate,
      durationDays: durationMinutes > 0
        ? Math.max(1, Math.ceil(durationMinutes / minutesPerDay))
        : Math.max(1, durationBetween(startDate, finishDate)),
      durationMinutes,
      durationFormat: Math.round(numberValue(rawTask.DurationFormat, 7)),
      actualStartDate: dateOnly(rawTask.ActualStart),
      actualEndDate: dateOnly(rawTask.ActualFinish),
      progress: normalizeProgress(rawTask.PercentComplete),
      predecessorExternalIds: predecessorDependencies.map((dependency) => dependency.predecessorExternalId),
      predecessorDependencies,
      taskMode: text(rawTask.Manual) === "1" ? "MANUAL" : "AUTO",
      isMilestone: text(rawTask.Milestone) === "1",
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
    const explicitDuration = Number(text(excelValue(row, "工期(天)", "工期", "Duration Days")));
    const predecessorValue = text(excelValue(row, "紧前任务ID", "Predecessors", "Predecessor"));

    return {
      externalId: text(excelValue(row, "任务ID", "Task ID", "ID")) || `row-${index + 1}`,
      parentExternalId: text(excelValue(row, "父任务ID", "Parent Task ID", "Parent ID")) || null,
      taskCategory: text(excelValue(row, "任务类别", "Category")),
      taskName,
      startDate,
      finishDate: finishDate || addDaysInclusive(startDate, Number.isInteger(explicitDuration) && explicitDuration > 0 ? explicitDuration : 1),
      durationDays: Number.isInteger(explicitDuration) && explicitDuration > 0
        ? explicitDuration
        : durationBetween(startDate, finishDate),
      durationMinutes: Math.max(0, Math.round(numberValue(excelValue(row, "工期(分钟)", "Duration Minutes"), 0)))
        || (Number.isInteger(explicitDuration) && explicitDuration > 0 ? explicitDuration * 480 : durationBetween(startDate, finishDate) * 480),
      durationFormat: Math.round(numberValue(excelValue(row, "工期格式", "Duration Format"), 7)),
      actualStartDate: dateOnly(excelValue(row, "实际开始", "Actual Start")),
      actualEndDate: dateOnly(excelValue(row, "实际完成", "Actual Finish")),
      progress: normalizeProgress(excelValue(row, "当前进度(%)", "当前进度", "Progress")),
      predecessorExternalIds: predecessorValue.split(/[,，;；\s]+/).filter(Boolean),
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
  if (extension === ".xlsx") return { tasks: parseGanttExcel(buffer, options.fallbackStartDate), metadata: null };
  if (extension === ".xml") return parseProjectXmlBundle(buffer.toString("utf8"));
  if (extension !== ".mpp") throw new Error("仅支持 .mpp、.xml 或 .xlsx 文件");

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

export const buildGanttExcel = (tasks: ProjectGanttTask[]) => {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const rows = tasks.map((task) => ({
    任务ID: task.taskCode,
    父任务ID: task.parentId ? taskById.get(task.parentId)?.taskCode ?? "" : "",
    任务类别: task.taskCategory,
    任务名称: task.taskName,
    计划开始: task.startDate,
    计划完成: task.finishDate || addDaysInclusive(task.startDate, task.durationDays),
    "工期(天)": task.durationDays,
    "工期(分钟)": task.durationMinutes || task.durationDays * 480,
    任务模式: task.taskMode ?? "AUTO",
    里程碑: task.isMilestone ? "是" : "否",
    WBS: task.wbsCode || task.taskCode.replace(/^Task/, ""),
    实际开始: task.actualStartDate,
    实际完成: task.actualEndDate,
    "当前进度(%)": task.progress,
    紧前任务ID: task.predecessorTaskIds?.map((id) => taskById.get(id)?.taskCode).filter(Boolean).join(",") || task.predecessorTask,
    基线开始: task.baselineStartDate ?? "",
    基线完成: task.baselineFinishDate ?? "",
    基线成本: task.baselineCost ?? 0,
    "完工预算(BAC)": task.budgetAtCompletion ?? 0,
    "实际成本(AC)": task.actualCost ?? 0,
  }));
  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet["!cols"] = [
    { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 32 }, { wch: 14 }, { wch: 14 },
    { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 14 },
    { wch: 14 }, { wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 16 },
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "项目进度");
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
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
    const durationMinutes = task.isMilestone ? 0 : (task.durationMinutes || task.durationDays * 480);
    const finishDate = task.finishDate || addDaysInclusive(task.startDate, task.durationDays);
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
      Priority: 500,
      Start: isoDateTime(task.startDate),
      Finish: isoDateTime(finishDate),
      Duration: durationMinutesToIso(durationMinutes),
      DurationFormat: task.durationFormat ?? 7,
      Work: durationMinutesToIso(durationMinutes),
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
      MinutesPerDay: 480,
      MinutesPerWeek: 2400,
      DaysPerMonth: 20,
      DefaultStartTime: "08:00:00",
      DefaultFinishTime: "17:00:00",
      CalendarUID: 1,
      ...(metadata?.projectSettings ?? {}),
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
  return Buffer.from(await response.arrayBuffer());
};

export const ganttTransferCapabilities = () => ({
  excelImport: true,
  excelExport: true,
  projectXmlImport: true,
  projectXmlExport: true,
  mppImport: true,
  mppExport: Boolean(process.env.PROJECT_MPP_EXPORT_SERVICE_URL?.trim()),
});
