import { orderGanttTasksByHierarchy, type GanttTaskCodeSource } from "@/lib/gantt-task-codes";
import { ganttTaskDepthById } from "@/lib/gantt-task-service";
import { itemStatusFromProgress } from "@/lib/item-progress";

export type AssistantExportType = "scheduleAnalysis" | "gantt" | "weekly" | "risk" | "budget";
export type GanttProgressFilter = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "INCOMPLETE";
export type WeeklyPriorityFilter = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type WeeklyStatusFilter = "PENDING" | "IN_PROGRESS" | "DONE";

export type AssistantProjectExportIntent = {
  exportType: AssistantExportType;
  taskDepths?: number[];
  /** Legacy actions created before project.export@3. */
  taskDepth?: number;
  taskProgress?: GanttProgressFilter;
  taskCategoryKeywords?: string[];
  includeProgressReport?: boolean;
  includeVisualization?: boolean;
  weeklyPriority?: WeeklyPriorityFilter;
  weeklyStatus?: WeeklyStatusFilter;
};

const chineseNumberByLabel: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
  十三: 13,
  十四: 14,
  十五: 15,
  十六: 16,
  十七: 17,
  十八: 18,
  十九: 19,
  二十: 20,
};

const depthTokenPattern = "(?:\\d{1,2}|二十|十[一二三四五六七八九]?|[一二三四五六七八九])";

const parseDepthToken = (token: string) => {
  const normalized = token.replace(/^第\s*/u, "").trim();
  const depth = chineseNumberByLabel[normalized] ?? Number(normalized);
  return Number.isInteger(depth) && depth >= 1 && depth <= 20 ? depth : null;
};

const uniqueDepths = (values: number[]) => Array.from(new Set(values)).sort((a, b) => a - b);

export const parseTaskDepths = (message: string) => {
  const range = message.match(new RegExp(`(?:第\\s*)?(${depthTokenPattern})\\s*(?:到|至|[-~—–])\\s*(?:第\\s*)?(${depthTokenPattern})\\s*(?:级|层级|层)`, "u"));
  if (range) {
    const start = parseDepthToken(range[1]);
    const end = parseDepthToken(range[2]);
    if (start !== null && end !== null) {
      const lower = Math.min(start, end);
      const upper = Math.max(start, end);
      return Array.from({ length: upper - lower + 1 }, (_, index) => lower + index);
    }
  }

  const list = message.match(new RegExp(`((?:第\\s*)?${depthTokenPattern}(?:\\s*(?:、|,|，|和|及|与|\\s+)\\s*(?:第\\s*)?${depthTokenPattern})+)\\s*(?:级|层级|层)`, "u"));
  if (list) {
    const depths = Array.from(list[1].matchAll(new RegExp(`(?:第\\s*)?(${depthTokenPattern})`, "gu")))
      .map((match) => parseDepthToken(match[1]))
      .filter((depth): depth is number => depth !== null);
    if (depths.length > 0) return uniqueDepths(depths);
  }

  const single = message.match(new RegExp(`(?:第\\s*)?(${depthTokenPattern})\\s*(?:级|层级|层)\\s*(?:的)?\\s*(?:甘特)?\\s*任务`, "u"));
  const depth = single ? parseDepthToken(single[1]) : null;
  return depth === null ? undefined : [depth];
};

const parseGanttProgress = (message: string): GanttProgressFilter | undefined => {
  if (/未完成.{0,14}(?:甘特)?任务|(?:甘特)?任务.{0,14}未完成/u.test(message)) return "INCOMPLETE";
  if (/已完成.{0,14}(?:甘特)?任务|(?:甘特)?任务.{0,14}已完成/u.test(message)) return "COMPLETED";
  if (/进行中.{0,14}(?:甘特)?任务|(?:甘特)?任务.{0,14}进行中/u.test(message)) return "IN_PROGRESS";
  if (/(?:未开始|待开始).{0,14}(?:甘特)?任务|(?:甘特)?任务.{0,14}(?:未开始|待开始)/u.test(message)) return "NOT_STARTED";
  return undefined;
};

const genericTaskCategoryLabels = new Set([
  "任务",
  "甘特",
  "甘特图",
  "项目",
  "项目进度",
  "进度",
  "所有",
  "全部",
  "当前",
  "级",
  "层",
]);

const normalizeTaskCategoryKeywords = (values: unknown[]) => {
  const keywords = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0
      && value.length <= 40
      && !genericTaskCategoryLabels.has(value)
      && !/(?:第?\s*[一二三四五六七八九十\d]+\s*(?:级|层)|层级|甘特)/u.test(value));
  return keywords.length > 0 ? Array.from(new Set(keywords)).slice(0, 20) : undefined;
};

export const parseTaskCategoryKeywords = (message: string) => {
  const explicit = Array.from(message.matchAll(/(?:任务类别|任务分类|类别|分类)\s*(?:为|是|包含|含有|属于|=|：|:)?\s*[“"]?([^，。；;、"”]{1,40})[”"]?/gu))
    .map((match) => match[1].replace(/(?:的)?(?:甘特)?任务.*$/u, "").trim());
  if (explicit.length > 0) return normalizeTaskCategoryKeywords(explicit);

  const candidates = Array.from(message.matchAll(/([\p{Script=Han}A-Za-z0-9_+\-/（）()]{1,60})(?:甘特)?任务/gu))
    .map((match) => {
      let value = match[1].trim();
      let previous = "";
      while (value !== previous) {
        previous = value;
        value = value.replace(/^(?:请|帮我|麻烦|给我|导出|下载|输出|生成|制作|整理|汇总|所有|全部|当前|项目|这些|那些|其中|对应|并且|同时|对|的)+/u, "");
      }
      return value.trim();
    });
  return normalizeTaskCategoryKeywords(candidates);
};

const requestsProgressReport = (message: string) => (
  /(?:进度|完成情况).{0,18}(?:总结|汇总|报告|分析)|(?:总结|汇总|报告|分析).{0,18}(?:任务|进度|完成情况)/u.test(message)
);

const requestsVisualization = (message: string) => /(?:数据)?可视化|图表|图形化|仪表盘/u.test(message);

const parseWeeklyPriority = (message: string): WeeklyPriorityFilter | undefined => {
  if (/紧急.{0,14}(?:项目)?事项|(?:项目)?事项.{0,14}(?:为|是|优先级)?\s*紧急/u.test(message)) return "URGENT";
  if (/高优先级.{0,14}(?:项目)?事项|(?:项目)?事项.{0,14}优先级\s*(?:为|是)?\s*高/u.test(message)) return "HIGH";
  if (/(?:普通|正常)优先级?.{0,14}(?:项目)?事项|(?:项目)?事项.{0,14}优先级\s*(?:为|是)?\s*(?:普通|正常)/u.test(message)) return "NORMAL";
  if (/低优先级.{0,14}(?:项目)?事项|(?:项目)?事项.{0,14}优先级\s*(?:为|是)?\s*低/u.test(message)) return "LOW";
  return undefined;
};

const parseWeeklyStatus = (message: string): WeeklyStatusFilter | undefined => {
  if (/已完成.{0,14}(?:项目)?事项|(?:项目)?事项.{0,14}已完成/u.test(message)) return "DONE";
  if (/进行中.{0,14}(?:项目)?事项|(?:项目)?事项.{0,14}进行中/u.test(message)) return "IN_PROGRESS";
  if (/(?:未开始|待开始).{0,14}(?:项目)?事项|(?:项目)?事项.{0,14}(?:未开始|待开始)/u.test(message)) return "PENDING";
  return undefined;
};

export const parseAssistantProjectExportIntent = (message: string): AssistantProjectExportIntent | null => {
  if (!/(导出|下载)/u.test(message)) return null;
  if (/(差异|冲突|计划分析|影响链)/u.test(message)) return { exportType: "scheduleAnalysis" };
  if (/(任务|甘特|进度)/u.test(message)) {
    const taskCategoryKeywords = parseTaskCategoryKeywords(message);
    const includeProgressReport = requestsProgressReport(message);
    return {
      exportType: "gantt",
      taskDepths: parseTaskDepths(message),
      taskProgress: parseGanttProgress(message),
      ...(taskCategoryKeywords ? { taskCategoryKeywords } : {}),
      ...(includeProgressReport ? { includeProgressReport: true } : {}),
    };
  }
  if (/(事项|本周)/u.test(message)) {
    return {
      exportType: "weekly",
      weeklyPriority: parseWeeklyPriority(message),
      weeklyStatus: parseWeeklyStatus(message),
    };
  }
  if (/风险/u.test(message)) return { exportType: "risk" };
  if (/(预算|成本)/u.test(message)) {
    return {
      exportType: "budget",
      ...(requestsVisualization(message) ? { includeVisualization: true } : {}),
    };
  }
  return null;
};

const taskProgressLabel: Record<GanttProgressFilter, string> = {
  NOT_STARTED: "未开始任务",
  IN_PROGRESS: "进行中任务",
  COMPLETED: "已完成任务",
  INCOMPLETE: "未完成任务",
};

const weeklyPriorityLabel: Record<WeeklyPriorityFilter, string> = {
  LOW: "低优先级事项",
  NORMAL: "普通事项",
  HIGH: "高优先级事项",
  URGENT: "紧急事项",
};

const weeklyStatusLabel: Record<WeeklyStatusFilter, string> = {
  PENDING: "未开始事项",
  IN_PROGRESS: "进行中事项",
  DONE: "已完成事项",
};

export const describeAssistantExportFilters = (intent: AssistantProjectExportIntent) => {
  const labels: string[] = [];
  const taskDepths = normalizeTaskDepthFilters(intent);
  if (taskDepths?.length) labels.push(`第 ${taskDepths.join("、")} 层任务`);
  if (intent.taskProgress) labels.push(taskProgressLabel[intent.taskProgress]);
  if (intent.taskCategoryKeywords?.length) labels.push(`任务类别包含“${intent.taskCategoryKeywords.join("”或“")}”`);
  if (intent.includeProgressReport) labels.push("附带进度总结报告");
  if (intent.includeVisualization) labels.push("附带预算汇总与数据可视化");
  if (intent.weeklyPriority) labels.push(weeklyPriorityLabel[intent.weeklyPriority]);
  if (intent.weeklyStatus) labels.push(weeklyStatusLabel[intent.weeklyStatus]);
  return labels;
};

type GanttExportRow = GanttTaskCodeSource & {
  parentId: string | null;
  progress: number;
  taskCategory?: string | null;
  taskName?: string | null;
};

export const normalizeTaskDepthFilters = (
  filters: Pick<AssistantProjectExportIntent, "taskDepths" | "taskDepth">,
) => {
  const depths = filters.taskDepths?.length
    ? filters.taskDepths
    : filters.taskDepth !== undefined
      ? [filters.taskDepth]
      : [];
  const valid = depths.filter((depth) => Number.isInteger(depth) && depth >= 1 && depth <= 20);
  return valid.length > 0 ? uniqueDepths(valid) : undefined;
};

export const normalizeAssistantProjectExportIntent = (value: Record<string, unknown>) => {
  const exportType = value.exportType;
  if (typeof exportType !== "string" || !(["gantt", "weekly", "risk", "budget"] as const).includes(exportType as "gantt" | "weekly" | "risk" | "budget")) return null;
  const normalizedExportType = exportType as Exclude<AssistantExportType, "scheduleAnalysis">;
  const explicitTaskDepths = Array.isArray(value.taskDepths)
    ? value.taskDepths.filter((item): item is number => typeof item === "number")
    : undefined;
  const legacyTaskDepth = typeof value.taskDepth === "number" ? value.taskDepth : undefined;
  const taskDepths = normalizeTaskDepthFilters({
    taskDepths: explicitTaskDepths,
    taskDepth: legacyTaskDepth,
  });
  if (explicitTaskDepths?.length && legacyTaskDepth !== undefined
    && JSON.stringify(taskDepths) !== JSON.stringify(normalizeTaskDepthFilters({ taskDepth: legacyTaskDepth }))) return null;
  const taskProgress = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "INCOMPLETE"].includes(String(value.taskProgress))
    ? value.taskProgress as GanttProgressFilter
    : undefined;
  const weeklyPriority = ["LOW", "NORMAL", "HIGH", "URGENT"].includes(String(value.weeklyPriority))
    ? value.weeklyPriority as WeeklyPriorityFilter
    : undefined;
  const weeklyStatus = ["PENDING", "IN_PROGRESS", "DONE"].includes(String(value.weeklyStatus))
    ? value.weeklyStatus as WeeklyStatusFilter
    : undefined;
  const taskCategoryKeywords = Array.isArray(value.taskCategoryKeywords)
    ? normalizeTaskCategoryKeywords(value.taskCategoryKeywords)
    : undefined;
  const includeProgressReport = typeof value.includeProgressReport === "boolean"
    ? value.includeProgressReport
    : undefined;
  const includeVisualization = typeof value.includeVisualization === "boolean"
    ? value.includeVisualization
    : undefined;

  if (normalizedExportType === "gantt" && (weeklyPriority || weeklyStatus || includeVisualization)) return null;
  if (normalizedExportType === "weekly" && (taskDepths || taskProgress || taskCategoryKeywords || includeProgressReport || includeVisualization)) return null;
  if (normalizedExportType === "risk" && (taskDepths || taskProgress || taskCategoryKeywords || includeProgressReport || includeVisualization || weeklyPriority || weeklyStatus)) return null;
  if (normalizedExportType === "budget" && (taskDepths || taskProgress || taskCategoryKeywords || includeProgressReport || weeklyPriority || weeklyStatus)) return null;
  return {
    exportType: normalizedExportType,
    ...(taskDepths ? { taskDepths } : {}),
    ...(taskProgress ? { taskProgress } : {}),
    ...(taskCategoryKeywords ? { taskCategoryKeywords } : {}),
    ...(includeProgressReport !== undefined ? { includeProgressReport } : {}),
    ...(includeVisualization !== undefined ? { includeVisualization } : {}),
    ...(weeklyPriority ? { weeklyPriority } : {}),
    ...(weeklyStatus ? { weeklyStatus } : {}),
  } satisfies AssistantProjectExportIntent;
};

export const assistantExportPlanPreservesRequest = (
  requested: AssistantProjectExportIntent,
  planned: AssistantProjectExportIntent,
) => {
  if (requested.exportType !== planned.exportType) return false;
  const requestedDepths = normalizeTaskDepthFilters(requested);
  const plannedDepths = normalizeTaskDepthFilters(planned);
  return JSON.stringify(requestedDepths ?? []) === JSON.stringify(plannedDepths ?? [])
    && requested.taskProgress === planned.taskProgress
    && JSON.stringify(requested.taskCategoryKeywords ?? []) === JSON.stringify(planned.taskCategoryKeywords ?? [])
    && requested.includeProgressReport === planned.includeProgressReport
    && requested.includeVisualization === planned.includeVisualization
    && requested.weeklyPriority === planned.weeklyPriority
    && requested.weeklyStatus === planned.weeklyStatus;
};

export const selectGanttExportRows = <T extends GanttExportRow>(
  rows: T[],
  filters: Pick<AssistantProjectExportIntent, "taskDepths" | "taskDepth" | "taskProgress" | "taskCategoryKeywords">,
) => {
  const ordered = orderGanttTasksByHierarchy(rows);
  const taskDepths = normalizeTaskDepthFilters(filters);
  const depthSet = taskDepths ? new Set(taskDepths) : null;
  const depthById = depthSet ? ganttTaskDepthById(rows) : null;
  return ordered.filter((row) => {
    if (depthSet && !depthSet.has(depthById?.get(row.id) ?? 1)) return false;
    if (filters.taskProgress === "NOT_STARTED" && row.progress !== 0) return false;
    if (filters.taskProgress === "IN_PROGRESS" && (row.progress <= 0 || row.progress >= 100)) return false;
    if (filters.taskProgress === "COMPLETED" && row.progress !== 100) return false;
    if (filters.taskProgress === "INCOMPLETE" && row.progress >= 100) return false;
    if (filters.taskCategoryKeywords?.length) {
      const searchable = `${row.taskCategory ?? ""} ${row.taskName ?? ""}`.toLocaleLowerCase("zh-CN");
      if (!filters.taskCategoryKeywords.some((keyword) => searchable.includes(keyword.toLocaleLowerCase("zh-CN")))) return false;
    }
    return true;
  });
};

type GanttProgressReportRow = {
  progress: number;
  finishDate?: string | null;
  taskCategory?: string | null;
};

export type GanttProgressReport = {
  total: number;
  completed: number;
  inProgress: number;
  notStarted: number;
  overdue: number;
  averageProgress: number;
  categoryBreakdown: Array<{ category: string; total: number; averageProgress: number }>;
  summary: string;
};

export const buildGanttProgressReport = <T extends GanttProgressReportRow>(
  rows: T[],
  statusDate = new Date().toISOString().slice(0, 10),
): GanttProgressReport => {
  const completed = rows.filter((row) => row.progress >= 100).length;
  const notStarted = rows.filter((row) => row.progress <= 0).length;
  const inProgress = Math.max(0, rows.length - completed - notStarted);
  const overdue = rows.filter((row) => Boolean(row.finishDate && row.finishDate < statusDate && row.progress < 100)).length;
  const averageProgress = rows.length > 0
    ? Math.round((rows.reduce((sum, row) => sum + Math.max(0, Math.min(100, row.progress)), 0) / rows.length) * 10) / 10
    : 0;
  const categoryMap = new Map<string, { total: number; progress: number }>();
  rows.forEach((row) => {
    const category = row.taskCategory?.trim() || "未分类";
    const current = categoryMap.get(category) ?? { total: 0, progress: 0 };
    current.total += 1;
    current.progress += Math.max(0, Math.min(100, row.progress));
    categoryMap.set(category, current);
  });
  const categoryBreakdown = Array.from(categoryMap, ([category, value]) => ({
    category,
    total: value.total,
    averageProgress: Math.round((value.progress / value.total) * 10) / 10,
  })).sort((a, b) => b.total - a.total || a.category.localeCompare(b.category, "zh-CN"));
  return {
    total: rows.length,
    completed,
    inProgress,
    notStarted,
    overdue,
    averageProgress,
    categoryBreakdown,
    summary: `共 ${rows.length} 项，已完成 ${completed} 项、进行中 ${inProgress} 项、未开始 ${notStarted} 项，平均进度 ${averageProgress}%，逾期未完成 ${overdue} 项。`,
  };
};

type WeeklyExportRow = {
  priority: string;
  progress: number;
};

export const selectWeeklyExportRows = <T extends WeeklyExportRow>(
  rows: T[],
  filters: Pick<AssistantProjectExportIntent, "weeklyPriority" | "weeklyStatus">,
) => rows.filter((row) => (
  (!filters.weeklyPriority || row.priority === filters.weeklyPriority)
  && (!filters.weeklyStatus || itemStatusFromProgress(row.progress) === filters.weeklyStatus)
));
