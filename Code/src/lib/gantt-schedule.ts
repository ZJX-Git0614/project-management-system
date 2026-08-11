import {
  calculateTaskFinishDate,
  calculateTaskStartDate,
  estimatedHoursForDuration,
  nextTaskStartDate,
  normalizeGanttDurationDays,
  normalizeTaskStartDate,
  shiftTaskDate,
  type GanttCalendarMode,
} from "@/lib/gantt-calendar";
import { normalizeGanttScheduleMode } from "@/lib/gantt-planning-rules";
import { GANTT_MINUTES_PER_DAY, ganttDependencyLagMinutes } from "@/lib/gantt-cpm";

export interface SchedulableGanttDependency {
  predecessorTaskId: string;
  type?: number;
  lag?: number;
  lagFormat?: number;
}

export interface SchedulableGanttTask {
  id: string;
  parentId?: string | null;
  startDate: string;
  finishDate?: string;
  durationDays: number;
  durationMinutes?: number;
  estimatedWorkHours?: number;
  taskMode?: string;
  parentBoundaryMode?: string;
  schedulePriority?: number;
  sortOrder?: number;
  progress?: number;
  actualStartDate?: string;
  actualEndDate?: string;
  resourceNotBeforeDate?: string;
  predecessorDependencies?: SchedulableGanttDependency[];
}

export interface GanttScheduleOptions {
  projectStartDate?: string;
  expectedEndDate?: string;
}

export interface ScheduledGanttTask extends SchedulableGanttTask {
  finishDate: string;
  durationMinutes: number;
  estimatedWorkHours: number;
}

const dependencyDate = (
  predecessor: ScheduledGanttTask,
  successorDuration: number,
  dependency: SchedulableGanttDependency,
  mode: GanttCalendarMode,
) => {
  const type = Number.isInteger(dependency.type) ? dependency.type! : 1;
  const lagMinutes = ganttDependencyLagMinutes(dependency);
  const lag = lagMinutes === 0
    ? 0
    : Math.sign(lagMinutes) * Math.ceil(Math.abs(lagMinutes) / GANTT_MINUTES_PER_DAY);
  const predecessorFinishDate = predecessor.progress != null
    && predecessor.progress >= 100
    && validDate(predecessor.actualEndDate)
    ? predecessor.actualEndDate!
    : predecessor.finishDate;
  if (type === 3) return shiftTaskDate(predecessor.startDate, lag, mode); // SS
  if (type === 0) {
    const requiredFinish = shiftTaskDate(predecessorFinishDate, lag, mode); // FF
    return calculateTaskStartDate(requiredFinish, successorDuration, mode);
  }
  if (type === 2) {
    const requiredFinish = shiftTaskDate(predecessor.startDate, lag, mode); // SF
    return calculateTaskStartDate(requiredFinish, successorDuration, mode);
  }
  return shiftTaskDate(nextTaskStartDate(predecessorFinishDate, mode), lag, mode); // FS
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value: string | null | undefined) => Boolean(value && DATE_PATTERN.test(value));
const isAutomaticTask = (task: SchedulableGanttTask) => (
  normalizeGanttScheduleMode(task.taskMode) === "AUTO"
  && (task.progress ?? 0) === 0
);

/**
 * Manual parent windows are hard constraints. A roll-up parent only derives
 * dates from children and must not silently constrain them.
 */
const parentScheduleBounds = <T extends SchedulableGanttTask>(
  task: T,
  taskById: Map<string, T>,
) => {
  let earliestStart = "";
  let latestFinish = "";
  const seen = new Set<string>([task.id]);
  let parentId = task.parentId ?? null;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = taskById.get(parentId);
    if (!parent) break;
    // Only an explicitly locked parent window is a hard scheduling boundary.
    // TARGET remains a planning target that can be exceeded with a warning.
    if (parent.parentBoundaryMode === "LOCKED") {
      if (validDate(parent.startDate) && (!earliestStart || parent.startDate > earliestStart)) {
        earliestStart = parent.startDate;
      }
      const parentFinishDate = parent.finishDate;
      if (validDate(parentFinishDate) && (!latestFinish || parentFinishDate! < latestFinish)) {
        latestFinish = parentFinishDate!;
      }
    }
    parentId = parent.parentId ?? null;
  }
  return { earliestStart, latestFinish };
};

export const scheduleGanttTasks = <T extends SchedulableGanttTask>(
  tasks: T[],
  mode: GanttCalendarMode,
  options: GanttScheduleOptions = {},
): Array<T & ScheduledGanttTask> => {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const inDegree = new Map(tasks.map((task) => [task.id, 0]));
  const successors = new Map<string, string[]>();

  tasks.forEach((task) => {
    (task.predecessorDependencies ?? []).forEach((dependency) => {
      if (!taskById.has(dependency.predecessorTaskId) || dependency.predecessorTaskId === task.id) return;
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      successors.set(dependency.predecessorTaskId, [
        ...(successors.get(dependency.predecessorTaskId) ?? []),
        task.id,
      ]);
    });
  });

  const queue = tasks.filter((task) => (inDegree.get(task.id) ?? 0) === 0).map((task) => task.id);
  const orderedIds: string[] = [];
  while (queue.length > 0) {
    const taskId = queue.shift()!;
    orderedIds.push(taskId);
    (successors.get(taskId) ?? []).forEach((successorId) => {
      const degree = (inDegree.get(successorId) ?? 0) - 1;
      inDegree.set(successorId, degree);
      if (degree === 0) queue.push(successorId);
    });
  }
  // A circular dependency has no valid topological order. Do not pick an
  // arbitrary sequence and silently overwrite dates; callers surface the
  // validation issue and keep the current plan instead.
  if (orderedIds.length !== tasks.length) {
    return tasks.map((task) => {
      const durationDays = normalizeGanttDurationDays(task.durationDays);
      const startDate = /^\d{4}-\d{2}-\d{2}$/.test(task.startDate)
        ? normalizeTaskStartDate(task.startDate, mode)
        : "";
      return {
        ...task,
        startDate,
        finishDate: /^\d{4}-\d{2}-\d{2}$/.test(task.finishDate ?? "")
          ? task.finishDate!
          : startDate && durationDays > 0 ? calculateTaskFinishDate(startDate, durationDays, mode) : "",
        durationDays,
        durationMinutes: Math.round(durationDays * 450),
        estimatedWorkHours: estimatedHoursForDuration(durationDays),
      };
    });
  }

  const scheduled = new Map<string, T & ScheduledGanttTask>();
  orderedIds.forEach((taskId) => {
    const task = taskById.get(taskId)!;
    const durationDays = normalizeGanttDurationDays(task.durationDays);
    const dependencies = (task.predecessorDependencies ?? [])
      .map((dependency) => ({ dependency, predecessor: scheduled.get(dependency.predecessorTaskId) }))
      .filter((item): item is { dependency: SchedulableGanttDependency; predecessor: T & ScheduledGanttTask } => Boolean(item.predecessor?.finishDate));
    const dependencyStarts = dependencies.map(({ dependency, predecessor }) => (
      dependencyDate(predecessor, durationDays, dependency, mode)
    ));
    const automatic = isAutomaticTask(task);
    const dependencyStartDate = durationDays > 0
      && automatic
      && dependencyStarts.length > 0
      ? dependencyStarts.sort().at(-1)!
      : normalizeTaskStartDate(task.startDate, mode);
    const resourceNotBeforeDate = /^\d{4}-\d{2}-\d{2}$/.test(task.resourceNotBeforeDate || "")
      ? normalizeTaskStartDate(task.resourceNotBeforeDate!, mode)
      : "";
    const bounds = parentScheduleBounds(task, taskById);
    const forwardAnchor = [dependencyStartDate, resourceNotBeforeDate, bounds.earliestStart]
      .filter(validDate)
      .sort()
      .at(-1) ?? "";
    const projectStartDate = validDate(options.projectStartDate)
      ? normalizeTaskStartDate(options.projectStartDate!, mode)
      : "";
    const backwardAnchor = bounds.latestFinish || (validDate(options.expectedEndDate) ? options.expectedEndDate! : "");
    const shouldScheduleBackward = automatic
      && durationDays > 0
      && !dependencyStartDate
      && !resourceNotBeforeDate
      && Boolean(backwardAnchor);
    const startDate = shouldScheduleBackward
      ? calculateTaskStartDate(backwardAnchor, durationDays, mode)
      : forwardAnchor || (automatic && durationDays > 0 && projectStartDate ? projectStartDate : dependencyStartDate);
    scheduled.set(taskId, {
      ...task,
      startDate,
      finishDate: durationDays > 0 ? calculateTaskFinishDate(startDate, durationDays, mode) : "",
      durationDays,
      durationMinutes: Math.round(durationDays * 450),
      estimatedWorkHours: estimatedHoursForDuration(durationDays),
    });
  });

  return tasks.map((task) => scheduled.get(task.id)!);
};
