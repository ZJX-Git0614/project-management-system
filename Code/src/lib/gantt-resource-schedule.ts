import { createHash } from "node:crypto";

import {
  calculateTaskFinishDate,
  calculateTaskStartDate,
  nextTaskStartDate,
  normalizeGanttDurationDays,
  normalizeTaskStartDate,
  shiftTaskDate,
  type GanttCalendarMode,
} from "@/lib/gantt-calendar";
import { GANTT_MINUTES_PER_DAY, ganttDependencyLagMinutes } from "@/lib/gantt-cpm";

export type ResourceScheduleTaskMode = "AUTO" | "MANUAL" | "FIXED";
export type ResourceScheduleCandidateKind = "MINIMAL_CHANGE" | "EARLIEST_FINISH" | "ON_TIME";

export interface ResourceScheduleDependency {
  predecessorTaskId: string;
  type?: number;
  lag?: number;
  lagFormat?: number;
}

export interface ResourceSchedulingTask {
  id: string;
  projectId: string;
  projectName?: string;
  taskName?: string;
  parentId?: string | null;
  isLeaf: boolean;
  ownerKeys: string[];
  startDate: string;
  finishDate: string;
  durationDays: number;
  durationMinutes?: number;
  estimatedWorkHours?: number;
  progress: number;
  taskMode: ResourceScheduleTaskMode | string;
  resourceNotBeforeDate?: string;
  sortOrder: number;
  predecessorDependencies: ResourceScheduleDependency[];
  isCurrentProject: boolean;
}

export interface ResourceConflict {
  id: string;
  ownerKey: string;
  taskIds: string[];
  projectIds: string[];
  startDate: string;
  finishDate: string;
  severity: "WARNING";
}

export interface ResourceScheduleChange {
  taskId: string;
  startDate: string;
  finishDate: string;
}

export interface ResourceScheduleMetrics {
  completionDate: string;
  delayedDays: number;
  movedTaskCount: number;
  totalShiftDays: number;
}

export interface ResourceScheduleCandidate {
  id: string;
  kind: ResourceScheduleCandidateKind;
  title: string;
  explanation: string;
  applicable: boolean;
  snapshotHash: string;
  changes: ResourceScheduleChange[];
  remainingConflicts: ResourceConflict[];
  metrics: ResourceScheduleMetrics;
}

export interface ResourceScheduleCandidateResult {
  snapshotHash: string;
  conflicts: ResourceConflict[];
  candidates: ResourceScheduleCandidate[];
}

interface Reservation {
  ownerKey: string;
  startDate: string;
  finishDate: string;
  taskId: string;
}

const manuallyScheduled = (task: ResourceSchedulingTask) => task.taskMode === "MANUAL";
const validDateRange = (task: ResourceSchedulingTask) => Boolean(
  task.startDate && task.finishDate && task.finishDate >= task.startDate && task.durationDays > 0,
);
const movableTask = (task: ResourceSchedulingTask) => (
  task.isCurrentProject
  && task.isLeaf
  && task.progress === 0
  && !manuallyScheduled(task)
  && task.ownerKeys.length > 0
  && validDateRange(task)
);

const dateMax = (values: string[]) => values.reduce((latest, value) => value > latest ? value : latest, "");
const dateDiff = (startDate: string, finishDate: string) => {
  if (!startDate || !finishDate) return 0;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const finish = Date.parse(`${finishDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return 0;
  return Math.round((finish - start) / 86_400_000);
};

const overlaps = (leftStart: string, leftFinish: string, rightStart: string, rightFinish: string) => (
  leftStart <= rightFinish && rightStart <= leftFinish
);

const conflictForOwner = (ownerKey: string, tasks: ResourceSchedulingTask[]): ResourceConflict[] => {
  const sorted = tasks
    .filter((task) => task.ownerKeys.includes(ownerKey) && task.isLeaf && task.progress < 100 && validDateRange(task))
    .sort((left, right) => left.startDate.localeCompare(right.startDate)
      || left.finishDate.localeCompare(right.finishDate)
      || left.sortOrder - right.sortOrder
      || left.id.localeCompare(right.id));
  const conflicts: ResourceConflict[] = [];
  let group: ResourceSchedulingTask[] = [];
  let groupFinish = "";
  const flush = () => {
    if (group.length < 2) {
      group = [];
      groupFinish = "";
      return;
    }
    const taskIds = group.map((task) => task.id);
    conflicts.push({
      id: `${ownerKey}:${taskIds.join(",")}`,
      ownerKey,
      taskIds,
      projectIds: [...new Set(group.map((task) => task.projectId))],
      startDate: group[0].startDate,
      finishDate: groupFinish,
      severity: "WARNING",
    });
    group = [];
    groupFinish = "";
  };

  sorted.forEach((task) => {
    if (group.length === 0) {
      group = [task];
      groupFinish = task.finishDate;
      return;
    }
    if (task.startDate <= groupFinish) {
      group.push(task);
      if (task.finishDate > groupFinish) groupFinish = task.finishDate;
      return;
    }
    flush();
    group = [task];
    groupFinish = task.finishDate;
  });
  flush();
  return conflicts;
};

export const detectResourceConflicts = (tasks: ResourceSchedulingTask[]): ResourceConflict[] => {
  const ownerKeys = [...new Set(tasks.flatMap((task) => task.ownerKeys))].sort();
  return ownerKeys.flatMap((ownerKey) => conflictForOwner(ownerKey, tasks));
};

const dependencyStartDate = (
  predecessor: ResourceSchedulingTask,
  successorDuration: number,
  dependency: ResourceScheduleDependency,
  mode: GanttCalendarMode,
) => {
  const lagMinutes = ganttDependencyLagMinutes(dependency);
  const lagDays = lagMinutes === 0
    ? 0
    : Math.sign(lagMinutes) * Math.ceil(Math.abs(lagMinutes) / GANTT_MINUTES_PER_DAY);
  const type = Number.isInteger(dependency.type) ? dependency.type : 1;
  if (type === 3) return shiftTaskDate(predecessor.startDate, lagDays, mode);
  if (type === 0) return calculateTaskStartDate(shiftTaskDate(predecessor.finishDate, lagDays, mode), successorDuration, mode);
  if (type === 2) return calculateTaskStartDate(shiftTaskDate(predecessor.startDate, lagDays, mode), successorDuration, mode);
  return shiftTaskDate(nextTaskStartDate(predecessor.finishDate, mode), lagDays, mode);
};

const criticalWeights = (tasks: ResourceSchedulingTask[]) => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const successors = new Map<string, string[]>();
  tasks.forEach((task) => task.predecessorDependencies.forEach((dependency) => {
    if (!byId.has(dependency.predecessorTaskId)) return;
    successors.set(dependency.predecessorTaskId, [...(successors.get(dependency.predecessorTaskId) ?? []), task.id]);
  }));
  const weights = new Map<string, number>();
  const visiting = new Set<string>();
  const resolve = (id: string): number => {
    if (weights.has(id)) return weights.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const task = byId.get(id);
    const tail = Math.max(0, ...(successors.get(id) ?? []).map(resolve));
    visiting.delete(id);
    const value = normalizeGanttDurationDays(task?.durationDays ?? 0) + tail;
    weights.set(id, value);
    return value;
  };
  tasks.forEach((task) => resolve(task.id));
  return weights;
};

const resourceStartDate = (
  startDate: string,
  durationDays: number,
  ownerKeys: string[],
  reservations: Reservation[],
  mode: GanttCalendarMode,
) => {
  let candidate = startDate;
  for (let iteration = 0; iteration < reservations.length + 2; iteration += 1) {
    const finishDate = calculateTaskFinishDate(candidate, durationDays, mode);
    const nextStarts = reservations
      .filter((reservation) => ownerKeys.includes(reservation.ownerKey))
      .filter((reservation) => overlaps(candidate, finishDate, reservation.startDate, reservation.finishDate))
      .map((reservation) => nextTaskStartDate(reservation.finishDate, mode));
    const next = dateMax([candidate, ...nextStarts]);
    if (next === candidate) return candidate;
    candidate = next;
  }
  return candidate;
};

const addReservations = (task: ResourceSchedulingTask, reservations: Reservation[], startDate = task.startDate, finishDate = task.finishDate) => {
  if (task.isLeaf && task.progress < 100 && task.durationDays > 0 && startDate && finishDate) {
    task.ownerKeys.forEach((ownerKey) => reservations.push({ ownerKey, startDate, finishDate, taskId: task.id }));
  }
};

const scheduleWithPriority = (
  tasks: ResourceSchedulingTask[],
  mode: GanttCalendarMode,
  kind: ResourceScheduleCandidateKind,
) => {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const weights = criticalWeights(tasks);
  const remaining = new Set(tasks.map((task) => task.id));
  const scheduled = new Map<string, ResourceSchedulingTask>();
  const reservations: Reservation[] = [];
  tasks.filter((task) => !movableTask(task)).forEach((task) => addReservations(task, reservations));
  const sortedByPriority = (items: ResourceSchedulingTask[]) => items.sort((left, right) => {
    if (kind === "EARLIEST_FINISH") {
      return (weights.get(right.id) ?? 0) - (weights.get(left.id) ?? 0)
        || right.durationDays - left.durationDays
        || left.startDate.localeCompare(right.startDate)
        || left.sortOrder - right.sortOrder;
    }
    if (kind === "ON_TIME") {
      return left.finishDate.localeCompare(right.finishDate)
        || (weights.get(right.id) ?? 0) - (weights.get(left.id) ?? 0)
        || left.sortOrder - right.sortOrder;
    }
    return left.startDate.localeCompare(right.startDate)
      || left.sortOrder - right.sortOrder
      || left.id.localeCompare(right.id);
  });

  while (remaining.size > 0) {
    const available = sortedByPriority(tasks.filter((task) => (
      remaining.has(task.id)
      && task.predecessorDependencies.every((dependency) => scheduled.has(dependency.predecessorTaskId) || !taskById.has(dependency.predecessorTaskId))
    )));
    const next = available[0] ?? tasks.find((task) => remaining.has(task.id));
    if (!next) break;
    remaining.delete(next.id);
    const dependencies = next.predecessorDependencies
      .map((dependency) => ({ dependency, predecessor: scheduled.get(dependency.predecessorTaskId) }))
      .filter((item): item is { dependency: ResourceScheduleDependency; predecessor: ResourceSchedulingTask } => Boolean(item.predecessor));
    const durationDays = normalizeGanttDurationDays(next.durationDays);
    const dependencyStarts = dependencies.map(({ dependency, predecessor }) => dependencyStartDate(predecessor, durationDays, dependency, mode));
    const requestedStart = dateMax([normalizeTaskStartDate(next.startDate, mode), ...dependencyStarts]);
    const canMove = movableTask(next);
    const startDate = canMove
      ? resourceStartDate(requestedStart, durationDays, next.ownerKeys, reservations, mode)
      : next.startDate;
    const finishDate = canMove
      ? (durationDays > 0 ? calculateTaskFinishDate(startDate, durationDays, mode) : "")
      : next.finishDate;
    const placed = { ...next, startDate, finishDate };
    scheduled.set(next.id, placed);
    if (canMove) addReservations(next, reservations, startDate, finishDate);
  }

  return tasks.map((task) => scheduled.get(task.id) ?? task);
};

const snapshotPayload = (tasks: ResourceSchedulingTask[]) => tasks
  .map((task) => ({
    id: task.id,
    projectId: task.projectId,
    startDate: task.startDate,
    finishDate: task.finishDate,
    durationDays: task.durationDays,
    progress: task.progress,
    taskMode: task.taskMode,
    resourceNotBeforeDate: task.resourceNotBeforeDate || "",
    ownerKeys: [...task.ownerKeys].sort(),
    predecessorDependencies: task.predecessorDependencies,
  }))
  .sort((left, right) => left.id.localeCompare(right.id));

export const resourceScheduleSnapshotHash = (tasks: ResourceSchedulingTask[]) => (
  createHash("sha256").update(JSON.stringify(snapshotPayload(tasks))).digest("hex")
);

const metricsFor = (
  original: ResourceSchedulingTask[],
  scheduled: ResourceSchedulingTask[],
  expectedEndDate: string,
): ResourceScheduleMetrics => {
  const originalById = new Map(original.map((task) => [task.id, task]));
  const currentTasks = scheduled.filter((task) => task.isCurrentProject && task.finishDate);
  const completionDate = currentTasks.reduce((latest, task) => task.finishDate > latest ? task.finishDate : latest, "");
  const delayedDays = expectedEndDate && completionDate > expectedEndDate ? dateDiff(expectedEndDate, completionDate) : 0;
  let movedTaskCount = 0;
  let totalShiftDays = 0;
  scheduled.forEach((task) => {
    const originalTask = originalById.get(task.id);
    if (!originalTask || originalTask.startDate === task.startDate) return;
    movedTaskCount += 1;
    totalShiftDays += Math.abs(dateDiff(originalTask.startDate, task.startDate));
  });
  return { completionDate, delayedDays, movedTaskCount, totalShiftDays };
};

export const applyResourceScheduleCandidate = (
  tasks: ResourceSchedulingTask[],
  candidate: Pick<ResourceScheduleCandidate, "changes">,
) => {
  const changes = new Map(candidate.changes.map((change) => [change.taskId, change]));
  return tasks.map((task) => {
    const change = changes.get(task.id);
    return change ? { ...task, startDate: change.startDate, finishDate: change.finishDate } : task;
  });
};

export const createResourceScheduleCandidates = (params: {
  tasks: ResourceSchedulingTask[];
  currentProjectId: string;
  calendarMode: GanttCalendarMode;
  expectedEndDate: string;
}): ResourceScheduleCandidateResult => {
  const snapshotHash = resourceScheduleSnapshotHash(params.tasks);
  const currentProjectTaskIds = new Set(
    params.tasks.filter((task) => task.projectId === params.currentProjectId).map((task) => task.id),
  );
  const relevantConflicts = (tasks: ResourceSchedulingTask[]) => detectResourceConflicts(tasks)
    .filter((conflict) => conflict.taskIds.some((taskId) => currentProjectTaskIds.has(taskId)));
  const conflicts = relevantConflicts(params.tasks);
  const candidates = ([
    ["MINIMAL_CHANGE", "最少改动", "优先保持原顺序与原日期，按负责人逐项串行，减少不必要的任务移动。"],
    ["EARLIEST_FINISH", "最早完成", "优先安排关键链路和较长任务，在负责人不可并行的约束下尽量缩短总工期。"],
    ["ON_TIME", "按期优先", "优先保护较早截止和关键路径任务，降低超过预计结项时间的风险。"],
  ] as const).map(([kind, title, explanation]) => {
    const scheduled = scheduleWithPriority(params.tasks, params.calendarMode, kind);
    const changes = scheduled
      .filter((task) => {
        const original = params.tasks.find((item) => item.id === task.id);
        return task.isCurrentProject && Boolean(original)
          && (task.startDate !== original!.startDate || task.finishDate !== original!.finishDate);
      })
      .map((task) => ({ taskId: task.id, startDate: task.startDate, finishDate: task.finishDate }));
    const remainingConflicts = relevantConflicts(scheduled);
    const metrics = metricsFor(params.tasks, scheduled, params.expectedEndDate);
    const applicable = changes.length > 0 && remainingConflicts.length < conflicts.length;
    return {
      id: `${snapshotHash}:${kind}`,
      kind,
      title,
      explanation,
      applicable,
      snapshotHash,
      changes,
      remainingConflicts,
      metrics,
    } satisfies ResourceScheduleCandidate;
  });
  return { snapshotHash, conflicts, candidates };
};
