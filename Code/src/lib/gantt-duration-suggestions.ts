import {
  calculateTaskDurationDays,
  normalizeGanttDurationDays,
  type GanttCalendarMode,
} from "@/lib/gantt-calendar";
import {
  buildGanttLeafScheduleNetwork,
  type GanttScheduleNetworkDependency,
} from "@/lib/gantt-schedule-network";

export interface GanttDurationSuggestionTask {
  id: string;
  projectId: string;
  parentId?: string | null;
  taskName?: string;
  ownerKeys: string[];
  startDate: string;
  finishDate: string;
  durationDays: number;
  isMilestone?: boolean;
  schedulePriority?: number;
  sortOrder: number;
  predecessorDependencies: GanttScheduleNetworkDependency[];
}

export interface GanttDurationSuggestion {
  taskId: string;
  parentTaskId: string;
  ownerKey: string;
  suggestedDurationDays: number;
  source: "SYSTEM_SUGGESTED";
  reason: string;
}

export interface GanttDurationSuggestionIssue {
  id: string;
  taskIds: string[];
  code: "MISSING_PARENT_WINDOW" | "MISSING_SINGLE_OWNER" | "INSUFFICIENT_PARENT_WINDOW";
  message: string;
}

export interface GanttDurationSuggestionResult {
  suggestions: GanttDurationSuggestion[];
  issues: GanttDurationSuggestionIssue[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HALF_DAY_UNITS = 2;

const taskPriority = (task: GanttDurationSuggestionTask) => (
  Math.max(0, Math.min(1000, Number(task.schedulePriority ?? 500)))
);

const parentWindowDays = (
  task: GanttDurationSuggestionTask,
  calendarMode: GanttCalendarMode,
) => {
  const duration = normalizeGanttDurationDays(task.durationDays);
  if (duration > 0) return duration;
  if (DATE_PATTERN.test(task.startDate) && DATE_PATTERN.test(task.finishDate) && task.finishDate >= task.startDate) {
    return normalizeGanttDurationDays(calculateTaskDurationDays(task.startDate, task.finishDate, calendarMode));
  }
  return 0;
};

const durationUnits = (durationDays: number) => Math.round(normalizeGanttDurationDays(durationDays) * HALF_DAY_UNITS);

/**
 * Produces deterministic 0.5-day recommendations for undated leaf work.
 * Recommendations never mutate the plan and therefore never become formal
 * scheduling constraints until a user explicitly applies them.
 */
export const createGanttDurationSuggestions = (
  tasks: GanttDurationSuggestionTask[],
  calendarMode: GanttCalendarMode,
): GanttDurationSuggestionResult => {
  const network = buildGanttLeafScheduleNetwork(tasks);
  const leafIds = new Set(network.leafTaskIds);
  const networkById = new Map(network.tasks.map((task) => [task.id, task] as const));
  const originalById = new Map(tasks.map((task) => [task.id, task] as const));

  const issues: GanttDurationSuggestionIssue[] = [];
  const candidates = tasks.filter((task) => (
    leafIds.has(task.id)
    && !task.isMilestone
    && normalizeGanttDurationDays(task.durationDays) <= 0
  ));

  candidates.forEach((task) => {
    if (task.ownerKeys.length !== 1) {
      issues.push({
        id: `duration-owner:${task.id}`,
        taskIds: [task.id],
        code: "MISSING_SINGLE_OWNER",
        message: `任务「${task.taskName || task.id}」缺少唯一负责人，无法生成建议工期。`,
      });
    } else if (!task.parentId || !originalById.has(task.parentId)) {
      issues.push({
        id: `duration-parent:${task.id}`,
        taskIds: [task.id],
        code: "MISSING_PARENT_WINDOW",
        message: `任务「${task.taskName || task.id}」缺少可用的父任务窗口，无法生成建议工期。`,
      });
    }
  });

  const eligible = candidates.filter((task) => (
    task.ownerKeys.length === 1
    && Boolean(task.parentId && originalById.has(task.parentId))
  ));
  const grouped = new Map<string, GanttDurationSuggestionTask[]>();
  eligible.forEach((task) => {
    const key = `${task.projectId}:${task.parentId}:${task.ownerKeys[0]}`;
    grouped.set(key, [...(grouped.get(key) ?? []), task]);
  });

  const suggestions: GanttDurationSuggestion[] = [];
  grouped.forEach((missingTasks) => {
    const first = missingTasks[0];
    const parent = originalById.get(first.parentId!);
    if (!parent) return;
    const windowDays = parentWindowDays(parent, calendarMode);
    if (windowDays <= 0) {
      missingTasks.forEach((task) => issues.push({
        id: `duration-window:${task.id}`,
        taskIds: [task.id, parent.id],
        code: "MISSING_PARENT_WINDOW",
        message: `父任务「${parent.taskName || parent.id}」没有正式工期或有效日期窗口，无法为子任务生成建议工期。`,
      }));
      return;
    }

    const formalSiblingUnits = tasks
      .filter((task) => (
        leafIds.has(task.id)
        && task.projectId === first.projectId
        && task.parentId === first.parentId
        && task.ownerKeys.length === 1
        && task.ownerKeys[0] === first.ownerKeys[0]
        && normalizeGanttDurationDays(task.durationDays) > 0
      ))
      .reduce((sum, task) => sum + durationUnits(task.durationDays), 0);
    const remainingUnits = durationUnits(windowDays) - formalSiblingUnits;
    const minimumUnitsPerTask = remainingUnits >= missingTasks.length * HALF_DAY_UNITS ? HALF_DAY_UNITS : 1;
    if (remainingUnits < missingTasks.length * minimumUnitsPerTask) {
      issues.push({
        id: `duration-insufficient:${parent.id}:${first.ownerKeys[0]}`,
        taskIds: [parent.id, ...missingTasks.map((task) => task.id)],
        code: "INSUFFICIENT_PARENT_WINDOW",
        message: `父任务「${parent.taskName || parent.id}」分配给该负责人的剩余窗口不足以容纳全部未定工期子任务。`,
      });
      return;
    }

    const ordered = [...missingTasks].sort((left, right) => (
      taskPriority(right) - taskPriority(left)
      || left.sortOrder - right.sortOrder
      || left.id.localeCompare(right.id)
    ));
    ordered.forEach((task, index) => {
      const units = index === ordered.length - 1
        ? remainingUnits - minimumUnitsPerTask * (ordered.length - 1)
        : minimumUnitsPerTask;
      suggestions.push({
        taskId: task.id,
        parentTaskId: parent.id,
        ownerKey: task.ownerKeys[0],
        suggestedDurationDays: units / HALF_DAY_UNITS,
        source: "SYSTEM_SUGGESTED",
        reason: `按父任务「${parent.taskName || parent.id}」窗口、同负责人串行容量和 WBS 稳定顺序确定性分配；FS 关系仅决定后续排期顺序，需用户确认后才成为正式工期。`,
      });
    });
  });

  // Keep result stable across database and JavaScript map iteration changes.
  suggestions.sort((left, right) => {
    const leftTask = networkById.get(left.taskId)!;
    const rightTask = networkById.get(right.taskId)!;
    return leftTask.sortOrder - rightTask.sortOrder || left.taskId.localeCompare(right.taskId);
  });
  return { suggestions, issues };
};
