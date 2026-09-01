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
import { isGanttFsDependency, normalizeGanttScheduleMode } from "@/lib/gantt-planning-rules";
import { GANTT_MINUTES_PER_DAY, ganttDependencyLagMinutes } from "@/lib/gantt-cpm";
import { buildGanttLeafScheduleNetwork } from "@/lib/gantt-schedule-network";

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
  dependency: SchedulableGanttDependency,
  mode: GanttCalendarMode,
) => {
  const lagMinutes = ganttDependencyLagMinutes(dependency);
  const lag = lagMinutes === 0
    ? 0
    : Math.sign(lagMinutes) * Math.ceil(Math.abs(lagMinutes) / GANTT_MINUTES_PER_DAY);
  const predecessorFinishDate = predecessor.progress != null
    && predecessor.progress >= 100
    && validDate(predecessor.actualEndDate)
    ? predecessor.actualEndDate!
    : predecessor.finishDate;
  return shiftTaskDate(nextTaskStartDate(predecessorFinishDate, mode), lag, mode);
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value: string | null | undefined) => Boolean(value && DATE_PATTERN.test(value));
const isAutomaticTask = (task: SchedulableGanttTask) => (
  normalizeGanttScheduleMode(task.taskMode) === "AUTO"
  && (task.progress ?? 0) === 0
);

/**
 * A completed predecessor is an execution fact. When that fact makes the
 * start of an unstarted date-fixed successor impossible, the successor must
 * return to automatic scheduling so the current forecast can move while the
 * published baseline remains untouched.
 */
export const fixedSuccessorTaskIdsBlockedByActualCompletion = <T extends SchedulableGanttTask>(
  tasks: T[],
  mode: GanttCalendarMode,
  changedPredecessorTaskIds?: Iterable<string>,
): string[] => {
  const network = buildGanttLeafScheduleNetwork(tasks);
  const networkTaskById = new Map(network.tasks.map((task) => [task.id, task] as const));
  const leafTaskIds = new Set(network.leafTaskIds);
  const changedPredecessors = changedPredecessorTaskIds
    ? new Set(changedPredecessorTaskIds)
    : null;
  const actualCompletionRootIds = new Set(
    [...(changedPredecessors ?? leafTaskIds)].filter((taskId) => {
      const task = networkTaskById.get(taskId);
      return Boolean(task)
        && Number(task!.progress ?? 0) >= 100
        && validDate(task!.actualEndDate);
    }),
  );
  if (actualCompletionRootIds.size === 0) return [];

  const successorsByPredecessorId = new Map<string, string[]>();
  network.tasks.forEach((task) => {
    (task.predecessorDependencies ?? []).filter(isGanttFsDependency).forEach((dependency) => {
      successorsByPredecessorId.set(dependency.predecessorTaskId, [
        ...(successorsByPredecessorId.get(dependency.predecessorTaskId) ?? []),
        task.id,
      ]);
    });
  });
  const affectedTaskIds = new Set<string>();
  const queue = [...actualCompletionRootIds];
  while (queue.length > 0) {
    const predecessorId = queue.shift()!;
    for (const successorId of successorsByPredecessorId.get(predecessorId) ?? []) {
      if (affectedTaskIds.has(successorId)) continue;
      affectedTaskIds.add(successorId);
      queue.push(successorId);
    }
  }

  const releasedTaskIds = new Set<string>();
  const propagatingTaskIds = new Set(actualCompletionRootIds);
  let workingTasks = network.tasks.map((task) => ({ ...task }));
  while (true) {
    const propagationQueue = [...propagatingTaskIds];
    while (propagationQueue.length > 0) {
      const predecessorId = propagationQueue.shift()!;
      for (const successorId of successorsByPredecessorId.get(predecessorId) ?? []) {
        const successor = networkTaskById.get(successorId);
        if (!successor
          || propagatingTaskIds.has(successorId)
          || Number(successor.progress ?? 0) > 0
          || normalizeGanttScheduleMode(successor.taskMode) !== "AUTO") {
          continue;
        }
        propagatingTaskIds.add(successorId);
        propagationQueue.push(successorId);
      }
    }

    const scheduled = scheduleGanttTasks(workingTasks, mode);
    const scheduledById = new Map(scheduled.map((task) => [task.id, task] as const));
    const newlyBlockedIds = workingTasks.flatMap((task) => {
      if (!leafTaskIds.has(task.id)
        || !affectedTaskIds.has(task.id)
        || releasedTaskIds.has(task.id)
        || Number(task.progress ?? 0) > 0
        || normalizeGanttScheduleMode(task.taskMode) !== "DATES_FIXED"
        || !validDate(task.startDate)) {
        return [];
      }

      const fixedStartDate = normalizeTaskStartDate(task.startDate, mode);
      const blocked = (task.predecessorDependencies ?? [])
        .filter(isGanttFsDependency)
        .some((dependency) => {
          if (!propagatingTaskIds.has(dependency.predecessorTaskId)) return false;
          const predecessor = scheduledById.get(dependency.predecessorTaskId);
          if (!predecessor) return false;
          const requiredStartDate = dependencyDate(predecessor, dependency, mode);
          return validDate(requiredStartDate) && requiredStartDate > fixedStartDate;
        });
      return blocked ? [task.id] : [];
    });
    if (newlyBlockedIds.length === 0) break;
    newlyBlockedIds.forEach((taskId) => {
      releasedTaskIds.add(taskId);
      propagatingTaskIds.add(taskId);
    });
    workingTasks = workingTasks.map((task) => (
      releasedTaskIds.has(task.id) ? { ...task, taskMode: "AUTO" } : task
    ));
  }

  return network.leafTaskIds.filter((taskId) => releasedTaskIds.has(taskId));
};

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
    (task.predecessorDependencies ?? []).filter(isGanttFsDependency).forEach((dependency) => {
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
    const dependencies = (task.predecessorDependencies ?? []).filter(isGanttFsDependency)
      .map((dependency) => ({ dependency, predecessor: scheduled.get(dependency.predecessorTaskId) }))
      .filter((item): item is { dependency: SchedulableGanttDependency; predecessor: T & ScheduledGanttTask } => Boolean(item.predecessor?.finishDate));
    const dependencyStarts = dependencies.map(({ dependency, predecessor }) => (
      dependencyDate(predecessor, dependency, mode)
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
