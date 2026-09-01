export type GanttColumnKey =
  | "sequence"
  | "drag"
  | "taskCode"
  | "taskCategory"
  | "taskName"
  | "taskDescription"
  | "owner"
  | "priority"
  | "durationDays"
  | "startDate"
  | "endDate"
  | "actualStartDate"
  | "actualEndDate"
  | "estimatedWorkHours"
  | "actualWorkHours"
  | "progress"
  | "totalFloat"
  | "freeFloat"
  | "earlyStart"
  | "earlyFinish"
  | "lateStart"
  | "lateFinish"
  | "scheduleStatus"
  | "predecessor"
  | "remark";

export type GanttColumnWidths = Record<GanttColumnKey, number>;

export interface GanttColumnLayoutTask {
  id: string;
  parentId?: string | null;
  taskCode?: string;
  taskCategory?: string;
  taskName?: string;
  taskDescription?: string;
  ownerMember?: { personName?: string; roleName?: string } | null;
  ownerMembers?: Array<{ personName?: string; roleName?: string }>;
  userPriority?: string;
  effectivePriority?: string;
  durationDays?: number;
  startDate?: string;
  endDate?: string;
  finishDate?: string;
  actualStartDate?: string;
  actualEndDate?: string;
  estimatedWorkHours?: number;
  actualWorkHours?: number;
  progress?: number;
  totalFloatMinutes?: number | null;
  freeFloatMinutes?: number | null;
  earlyStartDate?: string;
  earlyFinishDate?: string;
  lateStartDate?: string;
  lateFinishDate?: string;
  scheduleStatus?: string;
  predecessorTask?: string;
  predecessorTaskIds?: string[];
  remark?: string;
  isCritical?: boolean;
}

export const GANTT_EXPANDED_COLUMN_KEYS: GanttColumnKey[] = [
  "sequence",
  "drag",
  "taskCode",
  "taskCategory",
  "taskName",
  "taskDescription",
  "owner",
  "priority",
  "durationDays",
  "startDate",
  "endDate",
  "actualStartDate",
  "actualEndDate",
  "estimatedWorkHours",
  "actualWorkHours",
  "progress",
  "totalFloat",
  "freeFloat",
  "earlyStart",
  "earlyFinish",
  "lateStart",
  "lateFinish",
  "scheduleStatus",
  "predecessor",
  "remark",
];

export const GANTT_COLLAPSED_COLUMN_KEYS: GanttColumnKey[] = ["sequence", "drag", "taskCode", "taskName"];

export const GANTT_PINNED_COLUMN_KEYS: GanttColumnKey[] = ["sequence", "drag", "taskCode", "taskName"];

export const GANTT_DEFAULT_HIDDEN_COLUMN_KEYS: GanttColumnKey[] = [];

export const GANTT_HIDEABLE_COLUMN_KEYS: GanttColumnKey[] = GANTT_EXPANDED_COLUMN_KEYS.filter(
  (key) => !GANTT_PINNED_COLUMN_KEYS.includes(key),
);

export const GANTT_COLUMN_LABELS: Record<GanttColumnKey, string> = {
  sequence: "序号",
  drag: "",
  taskCode: "任务ID",
  taskCategory: "任务类别",
  taskName: "任务名称",
  taskDescription: "任务描述",
  owner: "负责人",
  priority: "优先级",
  durationDays: "工期",
  startDate: "计划开始",
  endDate: "计划完成",
  actualStartDate: "实际开始",
  actualEndDate: "实际完成",
  estimatedWorkHours: "预计工时",
  actualWorkHours: "实际工时",
  progress: "当前进度",
  totalFloat: "总浮动",
  freeFloat: "自由浮动",
  earlyStart: "最早开始",
  earlyFinish: "最早完成",
  lateStart: "最迟开始",
  lateFinish: "最迟完成",
  scheduleStatus: "排程状态",
  predecessor: "紧前任务",
  remark: "备注",
};

export const GANTT_COLUMN_MIN_WIDTHS: GanttColumnWidths = {
  sequence: 50,
  drag: 28,
  taskCode: 112,
  taskCategory: 86,
  taskName: 180,
  taskDescription: 220,
  // Reserve room for the owner text, conflict marker, and select chevron.
  owner: 176,
  priority: 76,
  durationDays: 56,
  startDate: 120,
  endDate: 120,
  actualStartDate: 120,
  actualEndDate: 120,
  estimatedWorkHours: 82,
  actualWorkHours: 82,
  progress: 76,
  totalFloat: 76,
  freeFloat: 76,
  earlyStart: 108,
  earlyFinish: 108,
  lateStart: 108,
  lateFinish: 108,
  scheduleStatus: 88,
  predecessor: 106,
  remark: 180,
};

const GANTT_COLUMN_MAX_WIDTHS: GanttColumnWidths = {
  sequence: 72,
  drag: 28,
  taskCode: 720,
  taskCategory: 520,
  taskName: 720,
  taskDescription: 720,
  owner: 320,
  priority: 104,
  durationDays: 120,
  startDate: 150,
  endDate: 150,
  actualStartDate: 150,
  actualEndDate: 150,
  estimatedWorkHours: 150,
  actualWorkHours: 150,
  progress: 120,
  totalFloat: 130,
  freeFloat: 130,
  earlyStart: 150,
  earlyFinish: 150,
  lateStart: 150,
  lateFinish: 150,
  scheduleStatus: 150,
  predecessor: 520,
  remark: 720,
};

const GANTT_FILTERABLE_COLUMN_KEYS = new Set<GanttColumnKey>([
  "taskName",
  "taskDescription",
  "owner",
  "durationDays",
  "startDate",
  "endDate",
  "predecessor",
]);

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
  const headerWidth = textWidth(GANTT_COLUMN_LABELS[key]) + (GANTT_FILTERABLE_COLUMN_KEYS.has(key) ? 48 : 30);
  const codeById = new Map(tasks.map((task) => [task.id, task.taskCode || task.id]));
  const values = tasks.map((task, index) => {
    const depth = depths.get(task.id) ?? 0;
    switch (key) {
      case "sequence": return textWidth(index + 1) + 26;
      case "drag": return 28;
      case "taskCode": return textWidth(task.taskCode || task.id) + depth * 10 + 92;
      case "taskCategory": return textWidth(task.taskCategory) + 28;
      case "taskName": return textWidth(task.taskName) + depth * 18 + (task.isCritical ? 92 : 28);
      case "taskDescription": return textWidth(task.taskDescription) + 28;
      case "owner": {
        const owners = task.ownerMembers?.length
          ? task.ownerMembers
          : task.ownerMember
            ? [task.ownerMember]
            : [];
        const ownerLabel = owners
          .map((owner) => [owner.personName, owner.roleName].filter(Boolean).join(" · "))
          .filter(Boolean)
          .join("、") || "未分配";
        // The rendered selector also has horizontal padding, a chevron, and may show a conflict marker.
        return textWidth(ownerLabel) + 72;
      }
      case "priority": return textWidth(task.effectivePriority || task.userPriority || "中") + 40;
      case "durationDays": return textWidth(task.durationDays && task.durationDays > 0 ? task.durationDays : "--") + 34;
      case "startDate": return textWidth(task.startDate) + 42;
      case "endDate": return textWidth(task.endDate || task.finishDate) + 42;
      case "actualStartDate": return textWidth(task.actualStartDate || "0000-00-00") + 42;
      case "actualEndDate": return textWidth(task.actualEndDate || "0000-00-00") + 42;
      case "estimatedWorkHours": return textWidth(task.estimatedWorkHours && task.estimatedWorkHours > 0 ? task.estimatedWorkHours.toFixed(2) : "--") + 36;
      case "actualWorkHours": return textWidth(task.actualWorkHours && task.actualWorkHours > 0 ? task.actualWorkHours.toFixed(2) : "--") + 36;
      case "progress": return textWidth(`${task.progress ?? 0}%`) + 38;
      case "totalFloat": return textWidth(task.totalFloatMinutes == null ? "--" : `${task.totalFloatMinutes / 450} 天`) + 28;
      case "freeFloat": return textWidth(task.freeFloatMinutes == null ? "--" : `${task.freeFloatMinutes / 450} 天`) + 28;
      case "earlyStart": return textWidth(task.earlyStartDate || "0000-00-00") + 28;
      case "earlyFinish": return textWidth(task.earlyFinishDate || "0000-00-00") + 28;
      case "lateStart": return textWidth(task.lateStartDate || "0000-00-00") + 28;
      case "lateFinish": return textWidth(task.lateFinishDate || "0000-00-00") + 28;
      case "scheduleStatus": return textWidth(task.scheduleStatus || "未排程") + 28;
      case "predecessor": {
        const linkedCodes = task.predecessorTaskIds?.map((id) => codeById.get(id)).filter(Boolean).join(", ");
        return textWidth(linkedCodes || task.predecessorTask || "无") + 38;
      }
      case "remark": return textWidth(task.remark) + 28;
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

export const ganttVisibleColumnKeys = (
  collapsed: boolean,
  hiddenKeys?: ReadonlySet<GanttColumnKey>,
): GanttColumnKey[] => (
  (collapsed ? GANTT_COLLAPSED_COLUMN_KEYS : GANTT_EXPANDED_COLUMN_KEYS)
    .filter((key) => GANTT_PINNED_COLUMN_KEYS.includes(key) || !hiddenKeys?.has(key))
);

export const ganttColumnTemplate = (
  widths: GanttColumnWidths,
  collapsed: boolean,
  hiddenKeys?: ReadonlySet<GanttColumnKey>,
) => (
  ganttVisibleColumnKeys(collapsed, hiddenKeys)
    .map((key) => `${widths[key]}px`)
    .join(" ")
);

export const ganttColumnsWidth = (
  widths: GanttColumnWidths,
  collapsed: boolean,
  hiddenKeys?: ReadonlySet<GanttColumnKey>,
) => (
  ganttVisibleColumnKeys(collapsed, hiddenKeys)
    .reduce((total, key) => total + widths[key], 0)
);
