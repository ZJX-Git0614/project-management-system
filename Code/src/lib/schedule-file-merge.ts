import path from "node:path";

import * as XLSX from "@e965/xlsx";

import {
  parseGanttExcel,
  parseGanttImportFile,
  type GanttImportBundle,
  type ImportedGanttTask,
} from "@/lib/gantt-file-transfer";
import { isValidGanttDurationDays, normalizeGanttDurationDays } from "@/lib/gantt-calendar";

export const SCHEDULE_MERGE_EXTENSIONS = [".mpp", ".xml", ".xls", ".xlsx", ".csv", ".md", ".txt"] as const;
export const SCHEDULE_CONVERT_EXTENSIONS = [".mpp", ".xml", ".xls", ".xlsx"] as const;
export const SCHEDULE_IMPORT_EXTENSIONS = [
  ".mpp",
  ".xml",
  ".xls",
  ".xlsx",
  ".csv",
  ".md",
  ".txt",
  ".docx",
  ".pdf",
] as const;

export type ScheduleMergeSource = {
  fileName: string;
  buffer: Buffer;
};

export type ScheduleImportHierarchyMode = "AUTO" | "FLAT";

export type ScheduleMergeWarning = {
  sourceFile: string;
  taskName?: string;
  message: string;
};

export type ScheduleMergeResult = {
  tasks: ImportedGanttTask[];
  warnings: ScheduleMergeWarning[];
  sourceSummaries: Array<{ fileName: string; taskCount: number }>;
  workbook: Buffer;
};

type ParsedSourceTask = {
  sourceIndex: number;
  sourceFile: string;
  sourceExternalId: string;
  generatedExternalId: boolean;
  task: ImportedGanttTask;
};

type HeaderMap = Map<string, number>;

const HEADER_ALIASES = {
  id: ["任务id", "任务编号", "编号", "taskid", "id"],
  parentId: ["父任务id", "父任务编号", "parenttaskid", "parentid"],
  category: ["任务类别", "类别", "category"],
  module: ["模块", "一级模块"],
  submodule: ["子模块", "二级模块"],
  taskName: ["任务名称", "任务名", "功能项", "工作项", "任务", "taskname", "name"],
  taskDescription: ["任务描述", "描述", "description", "notes"],
  owner: ["负责人", "责任人", "资源名称", "资源", "owner", "resource", "resourcename"],
  remark: ["备注", "备注信息", "remark", "remarks", "note"],
  start: ["计划开始", "计划开始时间", "开始时间", "start", "startdate"],
  finish: ["计划完成", "计划完成时间", "结束时间", "finish", "finishdate", "enddate"],
  duration: ["工期天", "工期", "durationdays", "duration"],
  actualStart: ["实际开始", "实际开始时间", "actualstart"],
  actualFinish: ["实际完成", "实际完成时间", "actualfinish"],
  progress: ["当前进度", "当前进度%", "进度", "progress", "percentcomplete"],
  predecessors: ["紧前任务id", "紧前任务", "前置任务", "依赖", "依赖条件", "predecessors", "predecessor"],
  estimatedWork: ["预计工时小时", "预计工时", "plannedworkhours", "workhours"],
  actualWork: ["实际工时小时", "实际工时", "actualworkhours"],
} as const;

const normalizeHeader = (value: unknown) => String(value ?? "")
  .trim()
  .toLocaleLowerCase("zh-CN")
  .replace(/[\s_（）()【】\[\]：:./\\-]+/g, "");

const cleanText = (value: unknown) => String(value ?? "").replace(/\u0000/g, "").trim();

const asDate = (value: unknown) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${String(parsed.y).padStart(4, "0")}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  const raw = cleanText(value);
  if (!raw) return "";
  const match = raw.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/u);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
};

const addDaysInclusive = (startDate: string, durationDays: number) => {
  if (!startDate || !Number.isFinite(durationDays) || durationDays <= 0) return "";
  const date = new Date(`${startDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Math.ceil(durationDays) - 1);
  return date.toISOString().slice(0, 10);
};

const durationBetween = (startDate: string, finishDate: string) => {
  if (!startDate || !finishDate) return 0;
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const finish = new Date(`${finishDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return 0;
  return Math.floor((finish - start) / 86_400_000) + 1;
};

const numberValue = (value: unknown, fallback = 0) => {
  const parsed = Number(cleanText(value).replace(/%$/, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const splitDependencies = (value: unknown) => cleanText(value)
  .split(/[,，;；、\s]+/u)
  .map((item) => item.trim())
  .filter((item) => item && !/^(无|none|n\/a|-|—)$/iu.test(item));

const headerIndex = (headers: unknown[], aliases: readonly string[]) => {
  const normalizedAliases = new Set(aliases.map(normalizeHeader));
  return headers.findIndex((header) => normalizedAliases.has(normalizeHeader(header)));
};

const buildHeaderMap = (headers: unknown[]): HeaderMap => {
  const map = new Map<string, number>();
  Object.entries(HEADER_ALIASES).forEach(([key, aliases]) => {
    const index = headerIndex(headers, aliases);
    if (index >= 0) map.set(key, index);
  });
  return map;
};

const readColumn = (row: unknown[], map: HeaderMap, key: keyof typeof HEADER_ALIASES) => {
  const index = map.get(key);
  return index === undefined ? "" : row[index];
};

const createTask = (params: {
  externalId: string;
  parentExternalId?: string;
  taskCategory?: string;
  taskName: string;
  taskDescription?: string;
  ownerName?: string;
  remark?: string;
  startDate: string;
  finishDate?: string;
  durationDays?: number;
  actualStartDate?: string;
  actualEndDate?: string;
  estimatedWorkHours?: number;
  actualWorkHours?: number;
  progress?: number;
  predecessorExternalIds?: string[];
  sortOrder: number;
}): ImportedGanttTask => {
  const sourceDuration = params.durationDays === undefined
    ? durationBetween(params.startDate, params.finishDate || "")
    : params.durationDays;
  const durationDays = normalizeGanttDurationDays(sourceDuration);
  const predecessorExternalIds = params.predecessorExternalIds ?? [];
  return {
    externalId: params.externalId,
    parentExternalId: params.parentExternalId || null,
    taskCategory: params.taskCategory || "",
    taskName: params.taskName,
    taskDescription: params.taskDescription || "",
    ownerName: params.ownerName || "",
    startDate: params.startDate,
    finishDate: params.finishDate || addDaysInclusive(params.startDate, durationDays),
    durationDays,
    durationMinutes: Math.round(durationDays * 450),
    durationFormat: 7,
    actualStartDate: params.actualStartDate || "",
    actualEndDate: params.actualEndDate || "",
    estimatedWorkHours: Math.max(0, params.estimatedWorkHours || 0),
    actualWorkHours: Math.max(0, params.actualWorkHours || 0),
    progress: Math.min(100, Math.max(0, Math.round(params.progress || 0))),
    remark: params.remark || "",
    predecessorExternalIds,
    predecessorDependencies: predecessorExternalIds.map((predecessorExternalId) => ({ predecessorExternalId, type: 1, lag: 0, lagFormat: 7 })),
    taskMode: "AUTO",
    isMilestone: false,
    wbsCode: "",
    outlineNumber: "",
    calendarUid: "",
    constraintType: null,
    constraintDate: "",
    baselineStartDate: "",
    baselineFinishDate: "",
    baselineCost: 0,
    budgetAtCompletion: 0,
    actualCost: 0,
    baselines: [],
    sortOrder: params.sortOrder,
  };
};

const rowsToTasks = (params: {
  rows: unknown[][];
  sourceKey: string;
  sourceFile: string;
  sheetName?: string;
  fallbackStartDate: string;
  defaultCategory?: string;
  warnings: ScheduleMergeWarning[];
}) => {
  const headerRowIndex = params.rows.findIndex((row) => buildHeaderMap(row).has("taskName"));
  if (headerRowIndex < 0) return [];
  const map = buildHeaderMap(params.rows[headerRowIndex]);
  const tasks: Array<{ task: ImportedGanttTask; generatedExternalId: boolean }> = [];
  params.rows.slice(headerRowIndex + 1).forEach((row, offset) => {
    const taskName = cleanText(readColumn(row, map, "taskName"));
    if (!taskName) return;
    const rowNumber = headerRowIndex + offset + 2;
    const explicitId = cleanText(readColumn(row, map, "id"));
    const externalId = explicitId || `${params.sourceKey}-row-${rowNumber}`;
    const startDate = asDate(readColumn(row, map, "start")) || params.fallbackStartDate;
    if (!startDate) throw new Error(`「${params.sourceFile}」中的任务“${taskName}”缺少计划开始日期，且当前项目未设置开始日期`);
    if (!asDate(readColumn(row, map, "start"))) {
      params.warnings.push({ sourceFile: params.sourceFile, taskName, message: `缺少计划开始日期，使用项目开始日期 ${startDate}` });
    }
    const finishDate = asDate(readColumn(row, map, "finish"));
    const durationValue = numberValue(readColumn(row, map, "duration"), Number.NaN);
    const durationDays = isValidGanttDurationDays(durationValue)
      ? normalizeGanttDurationDays(durationValue)
      : durationBetween(startDate, finishDate);
    if (!finishDate && !cleanText(readColumn(row, map, "duration"))) {
      params.warnings.push({ sourceFile: params.sourceFile, taskName, message: "缺少计划完成日期和工期，按未排期任务生成可导入记录" });
    }
    const category = [
      cleanText(readColumn(row, map, "category")),
      cleanText(readColumn(row, map, "module")),
      cleanText(readColumn(row, map, "submodule")),
    ].filter(Boolean).join(" / ") || params.defaultCategory || params.sheetName || "";
    tasks.push({
      generatedExternalId: !explicitId,
      task: createTask({
        externalId,
        parentExternalId: cleanText(readColumn(row, map, "parentId")),
        taskCategory: category,
        taskName,
        taskDescription: cleanText(readColumn(row, map, "taskDescription")),
        ownerName: cleanText(readColumn(row, map, "owner")),
        remark: cleanText(readColumn(row, map, "remark")),
        startDate,
        finishDate,
        durationDays,
        actualStartDate: asDate(readColumn(row, map, "actualStart")),
        actualEndDate: asDate(readColumn(row, map, "actualFinish")),
        estimatedWorkHours: numberValue(readColumn(row, map, "estimatedWork")),
        actualWorkHours: numberValue(readColumn(row, map, "actualWork")),
        progress: numberValue(readColumn(row, map, "progress")),
        predecessorExternalIds: splitDependencies(readColumn(row, map, "predecessors")),
        sortOrder: tasks.length + 1,
      }),
    });
  });
  return tasks;
};

const parseGenericWorkbook = (fileName: string, buffer: Buffer, fallbackStartDate: string, warnings: ScheduleMergeWarning[]) => {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sourceKey = path.basename(fileName, path.extname(fileName)).replace(/[^a-z0-9]+/gi, "-") || "sheet";
  return workbook.SheetNames.flatMap((sheetName, sheetIndex) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: true });
    return rowsToTasks({
      rows,
      sourceKey: `${sourceKey}-${sheetIndex + 1}`,
      sourceFile: fileName,
      sheetName,
      fallbackStartDate,
      warnings,
    });
  });
};

const splitMarkdownRow = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

const parseMarkdownTables = (fileName: string, content: string, fallbackStartDate: string, warnings: ScheduleMergeWarning[]) => {
  const lines = content.replace(/\r/g, "").split("\n");
  const tasks: Array<{ task: ImportedGanttTask; generatedExternalId: boolean }> = [];
  let heading = "";
  for (let index = 0; index < lines.length; index += 1) {
    const headingMatch = lines[index].match(/^\s*#{1,6}\s+(.+)$/u);
    if (headingMatch) heading = headingMatch[1].trim();
    if (!lines[index].includes("|") || !lines[index + 1]?.match(/^\s*\|?\s*:?-{3,}/u)) continue;
    const tableRows = [splitMarkdownRow(lines[index])];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].includes("|")) {
      tableRows.push(splitMarkdownRow(lines[cursor]));
      cursor += 1;
    }
    const parsed = rowsToTasks({
      rows: tableRows,
      sourceKey: `md-${index + 1}`,
      sourceFile: fileName,
      fallbackStartDate,
      defaultCategory: heading,
      warnings,
    });
    tasks.push(...parsed);
    index = cursor - 1;
  }
  return tasks;
};

const parseDelimitedText = (fileName: string, content: string, fallbackStartDate: string, warnings: ScheduleMergeWarning[]) => {
  const separator = content.includes("\t") ? "\t" : content.includes(",") ? "," : "";
  if (!separator) return [];
  const rows = content.replace(/\r/g, "").split("\n").filter((line) => line.trim()).map((line) => line.split(separator).map((cell) => cell.trim()));
  return rowsToTasks({ rows, sourceKey: "text", sourceFile: fileName, fallbackStartDate, warnings });
};

const parseDocumentTaskList = (fileName: string, content: string, fallbackStartDate: string, warnings: ScheduleMergeWarning[]) => {
  let heading = "文档导入";
  const tasks: Array<{ task: ImportedGanttTask; generatedExternalId: boolean }> = [];
  content.replace(/\r/g, "").split("\n").forEach((rawLine, lineIndex) => {
    const line = rawLine.trim();
    if (!line) return;
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/u)
      ?? line.match(/^(?:[一二三四五六七八九十]+|\d+)[、.]\s*(.{2,40})$/u);
    if (headingMatch && !/[：:]|\d{4}[-/.年]/u.test(line)) {
      heading = headingMatch[1].trim();
      return;
    }
    const itemMatch = line.match(/^(?:[-*•]|\d+(?:\.\d+)*[.)、])\s*(.+)$/u);
    if (!itemMatch) return;
    const sourceText = itemMatch[1].trim();
    if (!sourceText || /^(任务名称|工作项|功能项|序号)$/u.test(sourceText)) return;
    const dates = [...sourceText.matchAll(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/gu)]
      .map((match) => `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`);
    const durationMatch = sourceText.match(/(?:工期\s*[：:]?\s*)?(\d+(?:\.5)?)\s*(?:天|d\b)/iu);
    const progressMatch = sourceText.match(/(?:进度\s*[：:]?\s*)?(\d{1,3})\s*%/u);
    const ownerMatch = sourceText.match(/(?:负责人|责任人|owner)\s*[：:]\s*([^,，;；|]+?)(?=\s+(?:开始|结束|工期|进度|紧前任务|前置任务|依赖)\s*[：:]|$)/iu);
    const predecessorMatch = sourceText.match(/(?:紧前任务|前置任务|依赖)\s*[：:]\s*([^;；|]+)/u);
    const taskName = sourceText
      .split(/\s+[|｜]\s+|\s+(?:开始|结束|工期|进度|负责人|责任人|紧前任务|前置任务|依赖)\s*[：:]/u)[0]
      .replace(/[：:]$/u, "")
      .trim();
    if (!taskName) return;
    const startDate = dates[0] || fallbackStartDate;
    if (!startDate) throw new Error(`「${fileName}」中的任务“${taskName}”缺少计划开始日期，且当前项目未设置开始日期`);
    if (dates.length === 0) warnings.push({ sourceFile: fileName, taskName, message: `缺少计划开始日期，使用项目开始日期 ${startDate}` });
    const durationDays = durationMatch ? normalizeGanttDurationDays(Number(durationMatch[1])) : undefined;
    if (!dates[1] && durationDays === undefined) {
      warnings.push({ sourceFile: fileName, taskName, message: "缺少计划完成日期和工期，按未排期任务生成可导入记录" });
    }
    tasks.push({
      generatedExternalId: true,
      task: {
        ...createTask({
          externalId: `document-row-${lineIndex + 1}`,
          taskCategory: heading,
          taskName,
          taskDescription: sourceText,
          startDate,
          finishDate: dates[1],
          durationDays,
          progress: progressMatch ? Number(progressMatch[1]) : 0,
          predecessorExternalIds: predecessorMatch ? splitDependencies(predecessorMatch[1]) : [],
          sortOrder: tasks.length + 1,
        }),
        ownerName: ownerMatch?.[1]?.trim() || "",
      },
    });
  });
  return tasks;
};

const parseSource = async (source: ScheduleMergeSource, sourceIndex: number, fallbackStartDate: string, warnings: ScheduleMergeWarning[]) => {
  const extension = path.extname(source.fileName).toLocaleLowerCase("en-US");
  if (!SCHEDULE_MERGE_EXTENSIONS.includes(extension as typeof SCHEDULE_MERGE_EXTENSIONS[number])) {
    throw new Error(`「${source.fileName}」不是可合并的进度计划格式`);
  }

  let parsed: Array<{ task: ImportedGanttTask; generatedExternalId: boolean }> = [];
  if (extension === ".mpp" || extension === ".xml") {
    const bundle = await parseGanttImportFile(source.fileName, source.buffer, { fallbackStartDate });
    parsed = bundle.tasks.map((task) => ({ task, generatedExternalId: false }));
  } else if (extension === ".xlsx" || extension === ".xls") {
    try {
      const bundle = await parseGanttImportFile(source.fileName, source.buffer, { fallbackStartDate });
      parsed = bundle.tasks.map((task) => ({ task, generatedExternalId: /^row-\d+$/u.test(task.externalId) }));
    } catch {
      parsed = parseGenericWorkbook(source.fileName, source.buffer, fallbackStartDate, warnings);
    }
  } else if (extension === ".csv") {
    parsed = parseDelimitedText(source.fileName, source.buffer.toString("utf8"), fallbackStartDate, warnings);
    if (parsed.length === 0) parsed = parseGenericWorkbook(source.fileName, source.buffer, fallbackStartDate, warnings);
  } else {
    const content = source.buffer.toString("utf8");
    parsed = parseMarkdownTables(source.fileName, content, fallbackStartDate, warnings);
    if (parsed.length === 0 && extension === ".txt") parsed = parseDelimitedText(source.fileName, content, fallbackStartDate, warnings);
  }
  if (parsed.length === 0) throw new Error(`「${source.fileName}」中未识别到任务清单；请确保包含“任务名称”或“功能项”列`);
  return parsed.map(({ task, generatedExternalId }) => ({
    sourceIndex,
    sourceFile: source.fileName,
    sourceExternalId: task.externalId,
    generatedExternalId,
    task,
  } satisfies ParsedSourceTask));
};

const expandCategoryHierarchy = (tasks: ImportedGanttTask[]) => {
  const hasExplicitHierarchy = tasks.some((task) => task.parentExternalId || task.wbsCode || task.outlineNumber);
  if (hasExplicitHierarchy || !tasks.some((task) => task.taskCategory.trim())) return tasks;
  const result: ImportedGanttTask[] = [];
  const groupByPath = new Map<string, ImportedGanttTask>();
  const existingIds = new Set(tasks.map((task) => task.externalId));
  tasks.forEach((task) => {
    let segments = task.taskCategory.split(/\s*(?:\/|>|＞|\\)\s*/u).map((segment) => segment.trim()).filter(Boolean);
    if (segments.at(-1) === task.taskName.trim()) segments = segments.slice(0, -1);
    let parentExternalId: string | null = null;
    const pathParts: string[] = [];
    segments.forEach((segment) => {
      pathParts.push(segment);
      const categoryPath = pathParts.join(" / ");
      let group = groupByPath.get(categoryPath);
      if (!group) {
        let externalId = `__category__${encodeURIComponent(categoryPath)}`;
        let suffix = 1;
        while (existingIds.has(externalId)) {
          suffix += 1;
          externalId = `__category__${encodeURIComponent(categoryPath)}-${suffix}`;
        }
        existingIds.add(externalId);
        group = createTask({
          externalId,
          parentExternalId: parentExternalId ?? undefined,
          taskCategory: pathParts.slice(0, -1).join(" / "),
          taskName: segment,
          taskDescription: "由导入文件分类字段生成的 WBS 层级节点",
          startDate: task.startDate,
          finishDate: task.finishDate,
          durationDays: task.durationDays,
          progress: 0,
          sortOrder: result.length + 1,
        });
        groupByPath.set(categoryPath, group);
        result.push(group);
      } else {
        const startDate = [group.startDate, task.startDate].filter(Boolean).sort()[0] || group.startDate;
        const finishDate = [group.finishDate, task.finishDate].filter(Boolean).sort().at(-1) || group.finishDate;
        group.startDate = startDate;
        group.finishDate = finishDate;
        group.durationDays = normalizeGanttDurationDays(durationBetween(startDate, finishDate));
        group.durationMinutes = Math.round(group.durationDays * 450);
      }
      parentExternalId = group.externalId;
    });
    result.push({ ...task, parentExternalId: parentExternalId ?? task.parentExternalId, sortOrder: result.length + 1 });
  });
  return result.map((task, index) => ({ ...task, sortOrder: index + 1 }));
};

export const orderImportedScheduleTasksByHierarchy = <T extends {
  externalId: string;
  parentExternalId?: string | null;
}>(tasks: T[]) => {
  const byId = new Map(tasks.map((task) => [task.externalId, task]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: T[] = [];
  const visit = (task: T) => {
    if (visited.has(task.externalId)) return;
    if (visiting.has(task.externalId)) return;
    visiting.add(task.externalId);
    const parent = task.parentExternalId ? byId.get(task.parentExternalId) : undefined;
    if (parent) visit(parent);
    visiting.delete(task.externalId);
    visited.add(task.externalId);
    ordered.push(task);
  };
  tasks.forEach(visit);
  return ordered;
};

export const parseScheduleImportSource = async (
  source: ScheduleMergeSource & { extractedText?: string },
  fallbackStartDate: string,
  options: { hierarchyMode?: ScheduleImportHierarchyMode } = {},
): Promise<GanttImportBundle & { warnings: ScheduleMergeWarning[] }> => {
  const extension = path.extname(source.fileName).toLocaleLowerCase("en-US");
  if (!SCHEDULE_IMPORT_EXTENSIONS.includes(extension as typeof SCHEDULE_IMPORT_EXTENSIONS[number])) {
    throw new Error(`不支持的排期导入格式：${extension || "无扩展名"}`);
  }
  const warnings: ScheduleMergeWarning[] = [];
  if (extension === ".docx" || extension === ".pdf") {
    const content = source.extractedText?.trim() || "";
    if (!content) {
      throw new Error(extension === ".pdf"
        ? "PDF 未提取到可识别文本；扫描版 PDF 请先完成 OCR 后再导入"
        : "DOCX 未提取到可识别文本");
    }
    let parsed = parseMarkdownTables(source.fileName, content, fallbackStartDate, warnings);
    if (parsed.length === 0) parsed = parseDelimitedText(source.fileName, content, fallbackStartDate, warnings);
    if (parsed.length === 0) parsed = parseDocumentTaskList(source.fileName, content, fallbackStartDate, warnings);
    if (parsed.length === 0) throw new Error(`「${source.fileName}」中未识别到任务清单；请使用表格或编号列表明确任务名称`);
    const tasks = parsed.map((entry) => entry.task);
    return { tasks: options.hierarchyMode === "FLAT" ? tasks : expandCategoryHierarchy(tasks), metadata: null, warnings };
  }
  const parsed = await parseSource(source, 0, fallbackStartDate, warnings);
  const tasks = parsed.map((entry) => entry.task);
  return { tasks: options.hierarchyMode === "FLAT" ? tasks : expandCategoryHierarchy(tasks), metadata: null, warnings };
};

const normalizeIdentity = (value: string) => value.trim().toLocaleLowerCase("zh-CN");

const mergeParsedTasks = (parsedTasks: ParsedSourceTask[], warnings: ScheduleMergeWarning[]) => {
  const localIdMap = new Map<string, ParsedSourceTask>();
  const globalIdCandidates = new Map<string, ParsedSourceTask[]>();
  parsedTasks.forEach((entry) => {
    const normalizedId = normalizeIdentity(entry.sourceExternalId);
    localIdMap.set(`${entry.sourceIndex}:${normalizedId}`, entry);
    if (!entry.generatedExternalId) {
      const candidates = globalIdCandidates.get(normalizedId) ?? [];
      candidates.push(entry);
      globalIdCandidates.set(normalizedId, candidates);
    }
  });

  const uniqueTasks: ParsedSourceTask[] = [];
  const duplicateOf = new Map<ParsedSourceTask, ParsedSourceTask>();
  const explicitIdentity = new Map<string, ParsedSourceTask>();
  parsedTasks.forEach((entry) => {
    if (entry.generatedExternalId) {
      uniqueTasks.push(entry);
      return;
    }
    const key = `${normalizeIdentity(entry.sourceExternalId)}::${normalizeIdentity(entry.task.taskName)}`;
    const existing = explicitIdentity.get(key);
    if (!existing) {
      explicitIdentity.set(key, entry);
      uniqueTasks.push(entry);
      return;
    }
    duplicateOf.set(entry, existing);
    warnings.push({ sourceFile: entry.sourceFile, taskName: entry.task.taskName, message: `与「${existing.sourceFile}」中的同编号同名任务重复，已合并为一条` });
    existing.task.predecessorExternalIds = Array.from(new Set([...existing.task.predecessorExternalIds, ...entry.task.predecessorExternalIds]));
  });

  const finalIdByEntry = new Map<ParsedSourceTask, string>();
  uniqueTasks.forEach((entry, index) => finalIdByEntry.set(entry, `Task${String(index + 1).padStart(3, "0")}`));
  duplicateOf.forEach((target, duplicate) => finalIdByEntry.set(duplicate, finalIdByEntry.get(target)!));

  const resolveReference = (entry: ParsedSourceTask, reference: string) => {
    const normalized = normalizeIdentity(reference);
    const local = localIdMap.get(`${entry.sourceIndex}:${normalized}`);
    if (local) return local;
    const global = globalIdCandidates.get(normalized) ?? [];
    return global.length === 1 ? global[0] : null;
  };

  return uniqueTasks.map((entry, index) => {
    const predecessorIds = entry.task.predecessorExternalIds.flatMap((reference) => {
      const predecessor = resolveReference(entry, reference);
      const finalId = predecessor ? finalIdByEntry.get(predecessor) : "";
      if (!finalId) {
        warnings.push({ sourceFile: entry.sourceFile, taskName: entry.task.taskName, message: `未找到依赖任务“${reference}”，该依赖未写入合并文件` });
        return [];
      }
      return [finalId];
    });
    const parent = entry.task.parentExternalId ? resolveReference(entry, entry.task.parentExternalId) : null;
    if (entry.task.parentExternalId && !parent) {
      warnings.push({ sourceFile: entry.sourceFile, taskName: entry.task.taskName, message: `未找到父任务“${entry.task.parentExternalId}”，按顶层任务写入` });
    }
    const finalId = finalIdByEntry.get(entry)!;
    const uniquePredecessors = Array.from(new Set(predecessorIds)).filter((id) => id !== finalId);
    return {
      ...entry.task,
      externalId: finalId,
      parentExternalId: parent ? finalIdByEntry.get(parent) ?? null : null,
      predecessorExternalIds: uniquePredecessors,
      predecessorDependencies: uniquePredecessors.map((predecessorExternalId) => ({ predecessorExternalId, type: 1, lag: 0, lagFormat: 7 })),
      wbsCode: entry.task.wbsCode || String(index + 1),
      outlineNumber: entry.task.outlineNumber || String(index + 1),
      sortOrder: index + 1,
    } satisfies ImportedGanttTask;
  });
};

const buildWorkbook = (
  tasks: ImportedGanttTask[],
  sources: Array<{ fileName: string; taskCount: number }>,
  warnings: ScheduleMergeWarning[],
  mode: "CONVERT" | "MERGE",
) => {
  const rows = tasks.map((task) => ({
    任务ID: task.externalId,
    父任务ID: task.parentExternalId ?? "",
    任务类别: task.taskCategory,
    任务名称: task.taskName,
    计划开始: task.startDate,
    计划完成: task.finishDate,
    "工期(天)": task.durationDays > 0 ? task.durationDays : "",
    "预计工时(小时)": task.estimatedWorkHours > 0 ? task.estimatedWorkHours : "",
    实际开始: task.actualStartDate,
    实际完成: task.actualEndDate,
    "实际工时(小时)": task.actualWorkHours > 0 ? task.actualWorkHours : "",
    "当前进度(%)": task.progress,
    紧前任务ID: task.predecessorExternalIds.join(","),
    任务模式: task.taskMode,
    里程碑: task.isMilestone ? "是" : "否",
    WBS: task.wbsCode,
    基线开始: task.baselineStartDate,
    基线完成: task.baselineFinishDate,
    基线成本: task.baselineCost,
    "完工预算(BAC)": task.budgetAtCompletion,
    "实际成本(AC)": task.actualCost,
  }));
  const taskSheet = XLSX.utils.json_to_sheet(rows);
  taskSheet["!cols"] = [
    { wch: 14 }, { wch: 14 }, { wch: 24 }, { wch: 36 }, { wch: 14 }, { wch: 14 }, { wch: 10 },
    { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 24 }, { wch: 12 },
    { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 16 },
  ];
  taskSheet["!freeze"] = { xSplit: 0, ySplit: 1 };

  const actionLabel = mode === "CONVERT" ? "转换" : "合并";
  const noteRows: unknown[][] = [
    [`${actionLabel}结果`, mode === "CONVERT"
      ? `已将 ${sources[0]?.fileName || "源文件"} 转换为系统可导入格式，共 ${tasks.length} 条任务`
      : `共合并 ${sources.length} 个源文件、${tasks.length} 条任务`],
    ["说明", `任务按源文件及源文件内原始顺序排列；任务 ID 已统一重排为 Task001、Task002……`],
    ["说明", "未提供日期的任务使用当前项目开始日期；未提供计划完成和工期的任务按 1 天生成，具体项目事实未被自动补写"],
    [],
    ["源文件", "识别任务数"],
    ...sources.map((source) => [source.fileName, source.taskCount]),
    [],
    ["来源文件", "任务名称", "提示"],
    ...warnings.map((warning) => [warning.sourceFile, warning.taskName || "", warning.message]),
  ];
  const noteSheet = XLSX.utils.aoa_to_sheet(noteRows);
  noteSheet["!cols"] = [{ wch: 36 }, { wch: 36 }, { wch: 90 }];
  noteSheet["!freeze"] = { xSplit: 0, ySplit: 1 };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, taskSheet, "项目进度");
  XLSX.utils.book_append_sheet(workbook, noteSheet, `${actionLabel}说明`);
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
};

const buildScheduleResult = async (
  sources: ScheduleMergeSource[],
  fallbackStartDate: string,
  mode: "CONVERT" | "MERGE",
): Promise<ScheduleMergeResult> => {
  const warnings: ScheduleMergeWarning[] = [];
  const parsedBySource = await Promise.all(sources.map((source, index) => parseSource(source, index, fallbackStartDate, warnings)));
  const sourceSummaries = parsedBySource.map((tasks, index) => ({ fileName: sources[index].fileName, taskCount: tasks.length }));
  const tasks = mergeParsedTasks(parsedBySource.flat(), warnings);
  if (tasks.length === 0) throw new Error(`源文件中没有可${mode === "CONVERT" ? "转换" : "合并"}的任务`);
  const workbook = buildWorkbook(tasks, sourceSummaries, warnings, mode);
  const verified = parseGanttExcel(workbook, fallbackStartDate);
  if (verified.length !== tasks.length) throw new Error(`${mode === "CONVERT" ? "转换" : "合并"}文件生成后校验失败`);
  return { tasks, warnings, sourceSummaries, workbook };
};

export const convertScheduleFile = async (source: ScheduleMergeSource, fallbackStartDate: string): Promise<ScheduleMergeResult> => {
  const extension = path.extname(source.fileName).toLocaleLowerCase("en-US");
  if (!SCHEDULE_CONVERT_EXTENSIONS.includes(extension as typeof SCHEDULE_CONVERT_EXTENSIONS[number])) {
    throw new Error(`「${source.fileName}」不是可转换的甘特计划格式`);
  }
  return buildScheduleResult([source], fallbackStartDate, "CONVERT");
};

export const mergeScheduleFiles = async (sources: ScheduleMergeSource[], fallbackStartDate: string): Promise<ScheduleMergeResult> => {
  if (sources.length < 2) throw new Error("请至少上传两个需要合并的进度计划文件");
  return buildScheduleResult(sources, fallbackStartDate, "MERGE");
};
