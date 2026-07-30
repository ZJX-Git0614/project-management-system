import { orderGanttTasksByHierarchy, type GanttTaskCodeSource } from "@/lib/gantt-task-codes";
import { ganttTaskDepthById } from "@/lib/gantt-task-service";

export type AssistantExportType = "scheduleAnalysis" | "gantt" | "weekly" | "risk" | "budget";
export type GanttProgressFilter = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "INCOMPLETE";
export type WeeklyPriorityFilter = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type WeeklyStatusFilter = "PENDING" | "IN_PROGRESS" | "DONE" | "CANCELED";

export type AssistantProjectExportIntent = {
  exportType: AssistantExportType;
  taskDepth?: number;
  taskProgress?: GanttProgressFilter;
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
};

const parseTaskDepth = (message: string) => {
  const match = message.match(/(?:第\s*)?(\d+|一|二|三|四|五|六|七|八|九|十)\s*(?:级|层(?:级)?)\s*(?:的)?\s*(?:甘特)?\s*任务/u);
  if (!match) return undefined;
  const depth = chineseNumberByLabel[match[1]] ?? Number(match[1]);
  return Number.isInteger(depth) && depth >= 1 && depth <= 20 ? depth : undefined;
};

const parseGanttProgress = (message: string): GanttProgressFilter | undefined => {
  if (/未完成.{0,14}(?:甘特)?任务|(?:甘特)?任务.{0,14}未完成/u.test(message)) return "INCOMPLETE";
  if (/已完成.{0,14}(?:甘特)?任务|(?:甘特)?任务.{0,14}已完成/u.test(message)) return "COMPLETED";
  if (/进行中.{0,14}(?:甘特)?任务|(?:甘特)?任务.{0,14}进行中/u.test(message)) return "IN_PROGRESS";
  if (/(?:未开始|待开始).{0,14}(?:甘特)?任务|(?:甘特)?任务.{0,14}(?:未开始|待开始)/u.test(message)) return "NOT_STARTED";
  return undefined;
};

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
  if (/已取消.{0,14}(?:项目)?事项|(?:项目)?事项.{0,14}已取消/u.test(message)) return "CANCELED";
  return undefined;
};

export const parseAssistantProjectExportIntent = (message: string): AssistantProjectExportIntent | null => {
  if (!/(导出|下载)/u.test(message)) return null;
  if (/(差异|冲突|计划分析|影响链)/u.test(message)) return { exportType: "scheduleAnalysis" };
  if (/(任务|甘特|进度)/u.test(message)) {
    return {
      exportType: "gantt",
      taskDepth: parseTaskDepth(message),
      taskProgress: parseGanttProgress(message),
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
  if (/(预算|成本)/u.test(message)) return { exportType: "budget" };
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
  PENDING: "待开始事项",
  IN_PROGRESS: "进行中事项",
  DONE: "已完成事项",
  CANCELED: "已取消事项",
};

export const describeAssistantExportFilters = (intent: AssistantProjectExportIntent) => {
  const labels: string[] = [];
  if (intent.taskDepth) labels.push(`第 ${intent.taskDepth} 层任务`);
  if (intent.taskProgress) labels.push(taskProgressLabel[intent.taskProgress]);
  if (intent.weeklyPriority) labels.push(weeklyPriorityLabel[intent.weeklyPriority]);
  if (intent.weeklyStatus) labels.push(weeklyStatusLabel[intent.weeklyStatus]);
  return labels;
};

type GanttExportRow = GanttTaskCodeSource & {
  parentId: string | null;
  progress: number;
};

export const selectGanttExportRows = <T extends GanttExportRow>(
  rows: T[],
  filters: Pick<AssistantProjectExportIntent, "taskDepth" | "taskProgress">,
) => {
  const ordered = orderGanttTasksByHierarchy(rows);
  const depthById = filters.taskDepth ? ganttTaskDepthById(rows) : null;
  return ordered.filter((row) => {
    if (filters.taskDepth && (depthById?.get(row.id) ?? 1) !== filters.taskDepth) return false;
    if (filters.taskProgress === "NOT_STARTED" && row.progress !== 0) return false;
    if (filters.taskProgress === "IN_PROGRESS" && (row.progress <= 0 || row.progress >= 100)) return false;
    if (filters.taskProgress === "COMPLETED" && row.progress !== 100) return false;
    if (filters.taskProgress === "INCOMPLETE" && row.progress >= 100) return false;
    return true;
  });
};

type WeeklyExportRow = {
  priority: string;
  status: string;
};

export const selectWeeklyExportRows = <T extends WeeklyExportRow>(
  rows: T[],
  filters: Pick<AssistantProjectExportIntent, "weeklyPriority" | "weeklyStatus">,
) => rows.filter((row) => (
  (!filters.weeklyPriority || row.priority === filters.weeklyPriority)
  && (!filters.weeklyStatus || row.status === filters.weeklyStatus)
));
