export type GanttColumnKey =
  | "drag"
  | "taskCode"
  | "taskCategory"
  | "taskName"
  | "owner"
  | "durationDays"
  | "startDate"
  | "endDate"
  | "actualStartDate"
  | "actualEndDate"
  | "estimatedWorkHours"
  | "actualWorkHours"
  | "progress"
  | "predecessor";

export type GanttColumnWidths = Record<GanttColumnKey, number>;

export interface GanttColumnLayoutTask {
  id: string;
  parentId?: string | null;
  taskCode?: string;
  taskCategory?: string;
  taskName?: string;
  ownerMember?: { personName?: string; roleName?: string } | null;
  durationDays?: number;
  startDate?: string;
  endDate?: string;
  finishDate?: string;
  actualStartDate?: string;
  actualEndDate?: string;
  estimatedWorkHours?: number;
  actualWorkHours?: number;
  progress?: number;
  predecessorTask?: string;
  predecessorTaskIds?: string[];
  isCritical?: boolean;
}

export const GANTT_EXPANDED_COLUMN_KEYS: GanttColumnKey[] = [
  "drag",
  "taskCode",
  "taskCategory",
  "taskName",
  "owner",
  "durationDays",
  "startDate",
  "endDate",
  "actualStartDate",
  "actualEndDate",
  "estimatedWorkHours",
  "actualWorkHours",
  "progress",
  "predecessor",
];

export const GANTT_COLLAPSED_COLUMN_KEYS: GanttColumnKey[] = ["drag", "taskCode", "taskName"];

export const GANTT_COLUMN_LABELS: Record<GanttColumnKey, string> = {
  drag: "",
  taskCode: "任务ID",
  taskCategory: "任务类别",
  taskName: "任务名称",
  owner: "负责人",
  durationDays: "工期",
  startDate: "计划开始",
  endDate: "计划完成",
  actualStartDate: "实际开始",
  actualEndDate: "实际完成",
  estimatedWorkHours: "预计工时",
  actualWorkHours: "实际工时",
  progress: "当前进度",
  predecessor: "紧前任务",
};

export const GANTT_COLUMN_MIN_WIDTHS: GanttColumnWidths = {
  drag: 28,
  taskCode: 112,
  taskCategory: 86,
  taskName: 180,
  owner: 120,
  durationDays: 56,
  startDate: 108,
  endDate: 108,
  actualStartDate: 108,
  actualEndDate: 108,
  estimatedWorkHours: 82,
  actualWorkHours: 82,
  progress: 76,
  predecessor: 106,
};

const GANTT_COLUMN_MAX_WIDTHS: GanttColumnWidths = {
  drag: 28,
  taskCode: 720,
  taskCategory: 520,
  taskName: 720,
  owner: 260,
  durationDays: 120,
  startDate: 150,
  endDate: 150,
  actualStartDate: 150,
  actualEndDate: 150,
  estimatedWorkHours: 150,
  actualWorkHours: 150,
  progress: 120,
  predecessor: 520,
};

const textWidth = (value: unknown) => Array.from(String(value ?? "")).reduce((width, character) => (
  width + (/^[\u0000-\u00ff]$/.test(character) ? 7 : 12)
), 0);

export const ganttTaskDepths = (tasks: Array<Pick<GanttColumnLayoutTask, "id" | "parentId">>) => {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const depths = new Map<string, number>();
  const resolveDepth = (taskId: string, visiting = new Set<string>()): number => {
    const existing = depths.get(taskId);
    if (existing !== undefined) return existing;
    const task = taskById.get(taskId);
    if (!task?.parentId || !taskById.has(task.parentId) || visiting.has(task.parentId)) {
      depths.set(taskId, 0);
      return 0;
    }
    const nextVisiting = new Set(visiting).add(taskId);
    const depth = resolveDepth(task.parentId, nextVisiting) + 1;
    depths.set(taskId, depth);
    return depth;
  };
  tasks.forEach((task) => resolveDepth(task.id));
  return depths;
};

const clampedWidth = (key: GanttColumnKey, contentWidth: number) => Math.max(
  GANTT_COLUMN_MIN_WIDTHS[key],
  Math.min(GANTT_COLUMN_MAX_WIDTHS[key], Math.ceil(contentWidth)),
);

export const fitGanttColumnWidth = (
  key: GanttColumnKey,
  tasks: GanttColumnLayoutTask[],
  depths = ganttTaskDepths(tasks),
) => {
  const headerWidth = textWidth(GANTT_COLUMN_LABELS[key]) + 30;
  const codeById = new Map(tasks.map((task) => [task.id, task.taskCode || task.id]));
  const values = tasks.map((task) => {
    const depth = depths.get(task.id) ?? 0;
    switch (key) {
      case "drag": return 28;
      case "taskCode": return textWidth(task.taskCode || task.id) + depth * 10 + 92;
      case "taskCategory": return textWidth(task.taskCategory) + 28;
      case "taskName": return textWidth(task.taskName) + depth * 18 + (task.isCritical ? 92 : 28);
      case "owner": return textWidth(task.ownerMember ? `${task.ownerMember.personName ?? ""}（${task.ownerMember.roleName ?? ""}）` : "未分配") + 36;
      case "durationDays": return textWidth(task.durationDays ?? 0) + 34;
      case "startDate": return textWidth(task.startDate) + 42;
      case "endDate": return textWidth(task.endDate || task.finishDate) + 42;
      case "actualStartDate": return textWidth(task.actualStartDate || "0000-00-00") + 42;
      case "actualEndDate": return textWidth(task.actualEndDate || "0000-00-00") + 42;
      case "estimatedWorkHours": return textWidth(task.estimatedWorkHours ?? 0) + 36;
      case "actualWorkHours": return textWidth(task.actualWorkHours ?? 0) + 36;
      case "progress": return textWidth(`${task.progress ?? 0}%`) + 38;
      case "predecessor": {
        const linkedCodes = task.predecessorTaskIds?.map((id) => codeById.get(id)).filter(Boolean).join(", ");
        return textWidth(linkedCodes || task.predecessorTask || "无") + 38;
      }
    }
  });
  return clampedWidth(key, Math.max(headerWidth, ...values));
};

export const fitGanttColumnWidths = (tasks: GanttColumnLayoutTask[]): GanttColumnWidths => {
  const depths = ganttTaskDepths(tasks);
  return Object.fromEntries(GANTT_EXPANDED_COLUMN_KEYS.map((key) => [
    key,
    fitGanttColumnWidth(key, tasks, depths),
  ])) as GanttColumnWidths;
};

export const ganttColumnTemplate = (widths: GanttColumnWidths, collapsed: boolean) => (
  (collapsed ? GANTT_COLLAPSED_COLUMN_KEYS : GANTT_EXPANDED_COLUMN_KEYS)
    .map((key) => `${widths[key]}px`)
    .join(" ")
);

export const ganttColumnsWidth = (widths: GanttColumnWidths, collapsed: boolean) => (
  (collapsed ? GANTT_COLLAPSED_COLUMN_KEYS : GANTT_EXPANDED_COLUMN_KEYS)
    .reduce((total, key) => total + widths[key], 0)
);
