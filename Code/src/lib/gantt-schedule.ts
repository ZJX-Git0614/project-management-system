import {
  GANTT_HOURS_PER_DAY,
  calculateTaskFinishDate,
  calculateTaskStartDate,
  estimatedHoursForDuration,
  nextTaskStartDate,
  normalizeTaskStartDate,
  shiftTaskDate,
  type GanttCalendarMode,
} from "@/lib/gantt-calendar";

export interface SchedulableGanttDependency {
  predecessorTaskId: string;
  type?: number;
  lag?: number;
}

export interface SchedulableGanttTask {
  id: string;
  startDate: string;
  finishDate?: string;
  durationDays: number;
  durationMinutes?: number;
  estimatedWorkHours?: number;
  taskMode?: string;
  predecessorDependencies?: SchedulableGanttDependency[];
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
  // Microsoft Project stores LinkLag in tenths of a minute.
  const lag = Number.isInteger(dependency.lag)
    ? Math.round(dependency.lag! / (GANTT_HOURS_PER_DAY * 60 * 10))
    : 0;
  if (type === 3) return shiftTaskDate(predecessor.startDate, lag, mode); // SS
  if (type === 0) {
    const requiredFinish = shiftTaskDate(predecessor.finishDate, lag, mode); // FF
    return calculateTaskStartDate(requiredFinish, successorDuration, mode);
  }
  if (type === 2) {
    const requiredFinish = shiftTaskDate(predecessor.startDate, lag, mode); // SF
    return calculateTaskStartDate(requiredFinish, successorDuration, mode);
  }
  return shiftTaskDate(nextTaskStartDate(predecessor.finishDate, mode), lag, mode); // FS
};

export const scheduleGanttTasks = <T extends SchedulableGanttTask>(
  tasks: T[],
  mode: GanttCalendarMode,
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
  tasks.forEach((task) => {
    if (!orderedIds.includes(task.id)) orderedIds.push(task.id);
  });

  const scheduled = new Map<string, T & ScheduledGanttTask>();
  orderedIds.forEach((taskId) => {
    const task = taskById.get(taskId)!;
    const durationDays = Math.max(1, Math.trunc(task.durationDays));
    const dependencies = (task.predecessorDependencies ?? [])
      .map((dependency) => ({ dependency, predecessor: scheduled.get(dependency.predecessorTaskId) }))
      .filter((item): item is { dependency: SchedulableGanttDependency; predecessor: T & ScheduledGanttTask } => Boolean(item.predecessor));
    const dependencyStarts = dependencies.map(({ dependency, predecessor }) => (
      dependencyDate(predecessor, durationDays, dependency, mode)
    ));
    const startDate = task.taskMode !== "MANUAL" && dependencyStarts.length > 0
      ? dependencyStarts.sort().at(-1)!
      : normalizeTaskStartDate(task.startDate, mode);
    scheduled.set(taskId, {
      ...task,
      startDate,
      finishDate: calculateTaskFinishDate(startDate, durationDays, mode),
      durationDays,
      durationMinutes: durationDays * 450,
      estimatedWorkHours: estimatedHoursForDuration(durationDays),
    });
  });

  return tasks.map((task) => scheduled.get(task.id)!);
};
