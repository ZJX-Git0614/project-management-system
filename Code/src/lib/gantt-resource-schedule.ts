import { createHash } from "node:crypto";

import {
  GANTT_HOURS_PER_DAY,
  calculateTaskFinishDate,
  calculateTaskStartDate,
  ganttTaskWorkSlots,
  nextTaskStartDate,
  normalizeGanttDurationDays,
  normalizeTaskStartDate,
  shiftTaskDate,
  type GanttCalendarMode,
} from "@/lib/gantt-calendar";
import { GANTT_MINUTES_PER_DAY, ganttDependencyLagMinutes } from "@/lib/gantt-cpm";
import { normalizeGanttScheduleMode } from "@/lib/gantt-planning-rules";

export type ResourceScheduleTaskMode =
  | "AUTO"
  | "DURATION_FORWARD"
  | "DURATION_BACKWARD"
  | "DATES_FIXED"
  // Kept only for restoring snapshots created by earlier releases.
  | "MANUAL"
  | "LOCKED"
  | "FIXED";
export type ParentBoundaryMode = "ROLLUP" | "TARGET" | "LOCKED";
export type ResourceScheduleCandidateKind = "MINIMAL_CHANGE" | "EARLIEST_FINISH" | "ON_TIME" | "RESOURCE_SMOOTHING";
export type ResourceScheduleModeOverride = "PRESERVE" | "AUTO" | "DURATION_FORWARD" | "DURATION_BACKWARD";
export type ResourceScheduleIssueCode =
  | "DEPENDENCY_CYCLE"
  | "INVALID_DEPENDENCY"
  | "DEPENDENCY_CONSTRAINT"
  | "MISSING_START_DATE"
  | "PARENT_BOUNDARY_VIOLATION"
  | "PROJECT_HARD_FINISH_VIOLATION"
  | "RESOURCE_CAPACITY_EXCEEDED"
  | "RESOURCE_ASSIGNMENT_EXCEEDS_ALLOCATION"
  | "RESOURCE_SMOOTHING_LIMIT"
  | "MISSING_RESPONSIBLE_PERSON"
  | "MISSING_SCHEDULE_ANCHOR";

export interface ResourceScheduleDependency {
  predecessorTaskId: string;
  type?: number;
  lag?: number;
  lagFormat?: number;
}

export interface ResourceScheduleAssignment {
  ownerKey: string;
  /** Percentage of this named member's daily capacity allocated to this task. */
  unitsPercent?: number;
  /** Explicit effort assigned to this member. Empty means proportional allocation. */
  plannedWorkHours?: number;
  capacityHoursPerDay?: number;
  productivityRate?: number;
  /** 0 means that capacity is the only concurrency constraint. */
  maxConcurrentAssignments?: number;
}

export interface ResourceSchedulingTask {
  id: string;
  projectId: string;
  projectName?: string;
  taskName?: string;
  parentId?: string | null;
  isLeaf: boolean;
  /** Compatibility field for the existing Gantt owner relation. */
  ownerKeys: string[];
  ownerAssignments?: ResourceScheduleAssignment[];
  startDate: string;
  finishDate: string;
  durationDays: number;
  durationMinutes?: number;
  estimatedWorkHours?: number;
  progress: number;
  taskMode: ResourceScheduleTaskMode | string;
  parentBoundaryMode?: ParentBoundaryMode | string;
  schedulePriority?: number;
  effortDriven?: boolean;
  parallelizable?: boolean;
  resourceNotBeforeDate?: string;
  earlyStartDate?: string;
  lateStartDate?: string;
  lateFinishDate?: string;
  totalFloatMinutes?: number | null;
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
  severity: "WARNING" | "ERROR";
  reason: "CAPACITY_EXCEEDED" | "CONCURRENCY_EXCEEDED";
  allocatedHours?: number;
  capacityHours?: number;
  concurrentTaskCount?: number;
  maxConcurrentAssignments?: number;
}

export interface ResourceScheduleIssue {
  id: string;
  code: ResourceScheduleIssueCode;
  severity: "WARNING" | "ERROR";
  taskIds: string[];
  message: string;
  suggestion: string;
}

export interface ResourceScheduleChange {
  taskId: string;
  startDate: string;
  finishDate: string;
  /** Optional mode change requested by a scoped automatic scheduling run. */
  taskMode?: ResourceScheduleTaskMode;
}

export interface ResourceScheduleMetrics {
  completionDate: string;
  delayedDays: number;
  movedTaskCount: number;
  totalShiftDays: number;
  resolvedConflictCount: number;
  remainingCapacityOverloadCount: number;
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
  issues: ResourceScheduleIssue[];
  /** Tasks whose placement was constrained by resource capacity in this candidate. */
  resourceConstrainedTaskIds: string[];
  metrics: ResourceScheduleMetrics;
}

export interface ResourceScheduleCandidateResult {
  snapshotHash: string;
  conflicts: ResourceConflict[];
  issues: ResourceScheduleIssue[];
  candidates: ResourceScheduleCandidate[];
}

type ScheduledTask = ResourceSchedulingTask & { startDate: string; finishDate: string };

type NormalizedAssignment = Required<Pick<ResourceScheduleAssignment,
  "ownerKey" | "unitsPercent" | "plannedWorkHours" | "capacityHoursPerDay" | "productivityRate" | "maxConcurrentAssignments"
>>;

type DailyAllocation = {
  taskId: string;
  projectId: string;
  hours: number;
  capacityHours: number;
  maxConcurrentAssignments: number;
};

type CalendarSlot = DailyAllocation & { ownerKey: string; date: string };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EPSILON = 0.005;
const MAX_SEARCH_DAYS = 3_660;

const validDate = (value: string | null | undefined) => Boolean(value && DATE_PATTERN.test(value));
const validDateRange = (task: Pick<ResourceSchedulingTask, "startDate" | "finishDate" | "durationDays">) => (
  validDate(task.startDate)
  && validDate(task.finishDate)
  && task.finishDate >= task.startDate
  && normalizeGanttDurationDays(task.durationDays) > 0
);
const isLockedTask = (task: ResourceSchedulingTask) => (
  normalizeGanttScheduleMode(task.taskMode) !== "AUTO" || task.progress > 0
);
const isMovableTask = (task: ResourceSchedulingTask) => (
  task.isCurrentProject
  && task.isLeaf
  && !isLockedTask(task)
  && normalizeGanttDurationDays(task.durationDays) > 0
);
const normalizeBoundaryMode = (value: unknown): ParentBoundaryMode => (
  value === "TARGET" || value === "LOCKED" ? value : "ROLLUP"
);
const dateMax = (values: Array<string | null | undefined>) => values.filter(validDate).sort().at(-1) ?? "";
const dateMin = (values: Array<string | null | undefined>) => values.filter(validDate).sort().at(0) ?? "";
const dateDiff = (startDate: string, finishDate: string) => {
  if (!validDate(startDate) || !validDate(finishDate)) return 0;
  return Math.round((Date.parse(`${finishDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
};
const nextCalendarDate = (date: string) => new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  ? new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  : date;

const normalizedAssignments = (task: ResourceSchedulingTask): NormalizedAssignment[] => {
  const incoming: ResourceScheduleAssignment[] = task.ownerAssignments?.length
    ? task.ownerAssignments
    : task.ownerKeys.map((ownerKey) => ({ ownerKey }));
  const byOwner = new Map<string, ResourceScheduleAssignment>();
  incoming.forEach((assignment) => {
    const ownerKey = String(assignment.ownerKey || "").trim();
    if (!ownerKey) return;
    const current = byOwner.get(ownerKey);
    if (!current) {
      byOwner.set(ownerKey, { ...assignment, ownerKey });
      return;
    }
    byOwner.set(ownerKey, {
      ...current,
      plannedWorkHours: Math.max(0, Number(current.plannedWorkHours ?? 0)) + Math.max(0, Number(assignment.plannedWorkHours ?? 0)),
      unitsPercent: Math.max(Number(current.unitsPercent ?? 0), Number(assignment.unitsPercent ?? 0)),
      capacityHoursPerDay: Math.min(
        Number(current.capacityHoursPerDay ?? GANTT_HOURS_PER_DAY) || GANTT_HOURS_PER_DAY,
        Number(assignment.capacityHoursPerDay ?? GANTT_HOURS_PER_DAY) || GANTT_HOURS_PER_DAY,
      ),
      productivityRate: Math.min(
        Number(current.productivityRate ?? 1) || 1,
        Number(assignment.productivityRate ?? 1) || 1,
      ),
      maxConcurrentAssignments: Math.min(
        Number(current.maxConcurrentAssignments ?? 0) || Number.POSITIVE_INFINITY,
        Number(assignment.maxConcurrentAssignments ?? 0) || Number.POSITIVE_INFINITY,
      ),
    });
  });
  const source = [...byOwner.values()];
  if (source.length === 0) return [];
  const totalUnits = source.reduce((sum, assignment) => sum + Math.max(1, Math.min(100, Number(assignment.unitsPercent ?? 100))), 0);
  // The product default is duration x 7.5 h. An explicitly effort-driven task
  // is the only case where a separately maintained estimate takes precedence.
  const totalWorkHours = task.effortDriven && Number(task.estimatedWorkHours) > 0
    ? Number(task.estimatedWorkHours)
    : normalizeGanttDurationDays(task.durationDays) * GANTT_HOURS_PER_DAY;
  return source.map((assignment) => {
    const unitsPercent = Math.max(1, Math.min(100, Math.round(Number(assignment.unitsPercent ?? 100))));
    const explicitWork = Math.max(0, Number(assignment.plannedWorkHours ?? 0));
    const capacityHoursPerDay = Math.max(EPSILON, Number(assignment.capacityHoursPerDay ?? GANTT_HOURS_PER_DAY));
    const productivityRate = Math.max(EPSILON, Number(assignment.productivityRate ?? 1));
    const concurrency = Number(assignment.maxConcurrentAssignments ?? 0);
    return {
      ownerKey: assignment.ownerKey,
      unitsPercent,
      plannedWorkHours: explicitWork > 0 ? explicitWork : totalWorkHours * (unitsPercent / totalUnits),
      capacityHoursPerDay,
      productivityRate,
      maxConcurrentAssignments: Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 0,
    };
  });
};

const assignmentDailyCapacity = (assignment: NormalizedAssignment) => (
  assignment.capacityHoursPerDay * assignment.productivityRate
);

const allocationDailyLimit = (assignment: NormalizedAssignment) => (
  assignmentDailyCapacity(assignment) * assignment.unitsPercent / 100
);

const taskDailyAllocations = (
  task: ResourceSchedulingTask,
  startDate: string,
  mode: GanttCalendarMode,
): CalendarSlot[] => {
  const durationDays = normalizeGanttDurationDays(task.durationDays);
  if (!task.isLeaf || task.progress >= 100 || durationDays <= 0 || !validDate(startDate)) return [];
  const slots = ganttTaskWorkSlots(startDate, durationDays, mode);
  return normalizedAssignments(task).flatMap((assignment) => {
    const perDayHours = assignment.plannedWorkHours / durationDays;
    return slots.map((slot) => ({
      taskId: task.id,
      projectId: task.projectId,
      hours: perDayHours * slot.portion,
      // A member assigned at 50% may only contribute half of their daily capacity
      // to this task. Capacity checks must use this allocation limit rather than
      // the member's full calendar capacity.
      capacityHours: allocationDailyLimit(assignment),
      maxConcurrentAssignments: assignment.maxConcurrentAssignments,
      ownerKey: assignment.ownerKey,
      date: slot.date,
    }));
  });
};

class ResourceCapacityCalendar {
  private readonly allocations = new Map<string, Map<string, CalendarSlot[]>>();

  forEachAllocation(visitor: (allocations: Map<string, Map<string, CalendarSlot[]>>) => void) {
    visitor(this.allocations);
  }

  addTask(task: ResourceSchedulingTask, startDate: string, mode: GanttCalendarMode) {
    taskDailyAllocations(task, startDate, mode).forEach((allocation) => {
      const byDate = this.allocations.get(allocation.ownerKey) ?? new Map<string, CalendarSlot[]>();
      const existing = byDate.get(allocation.date) ?? [];
      existing.push(allocation);
      byDate.set(allocation.date, existing);
      this.allocations.set(allocation.ownerKey, byDate);
    });
  }

  canPlace(task: ResourceSchedulingTask, startDate: string, mode: GanttCalendarMode) {
    const proposed = taskDailyAllocations(task, startDate, mode);
    for (const allocation of proposed) {
      const existing = this.allocations.get(allocation.ownerKey)?.get(allocation.date) ?? [];
      const distinctTaskIds = new Set(existing.map((entry) => entry.taskId));
      const existingHours = existing.reduce((sum, entry) => sum + entry.hours, 0);
      const capacity = Math.min(
        allocation.capacityHours,
        ...existing.map((entry) => entry.capacityHours),
      );
      if (existingHours + allocation.hours > capacity + EPSILON) return false;
      const concurrentLimit = [allocation.maxConcurrentAssignments, ...existing.map((entry) => entry.maxConcurrentAssignments)]
        .filter((value) => value > 0)
        .reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY);
      if (Number.isFinite(concurrentLimit) && !distinctTaskIds.has(task.id) && distinctTaskIds.size + 1 > concurrentLimit) return false;
    }
    return true;
  }
}

const collectDailyConflicts = (tasks: ResourceSchedulingTask[], mode: GanttCalendarMode): ResourceConflict[] => {
  const calendar = new ResourceCapacityCalendar();
  tasks.filter(validDateRange).forEach((task) => calendar.addTask(task, task.startDate, mode));
  const raw: ResourceConflict[] = [];
  calendar.forEachAllocation((allocationsByOwner) => allocationsByOwner.forEach((byDate, ownerKey) => {
    byDate.forEach((allocations, date) => {
      const taskIds = [...new Set(allocations.map((entry) => entry.taskId))].sort();
      if (taskIds.length === 0) return;
      const totalHours = allocations.reduce((sum, entry) => sum + entry.hours, 0);
      const capacityHours = Math.min(...allocations.map((entry) => entry.capacityHours));
      const concurrency = allocations.map((entry) => entry.maxConcurrentAssignments).filter((value) => value > 0);
      const maxConcurrentAssignments = concurrency.length ? Math.min(...concurrency) : 0;
      if (totalHours > capacityHours + EPSILON) {
        raw.push({
          id: `${ownerKey}:${date}:CAPACITY`, ownerKey, taskIds,
          projectIds: [...new Set(allocations.map((entry) => entry.projectId))].sort(),
          startDate: date, finishDate: date, severity: "WARNING", reason: "CAPACITY_EXCEEDED",
          allocatedHours: Math.round(totalHours * 100) / 100, capacityHours: Math.round(capacityHours * 100) / 100,
        });
      }
      if (maxConcurrentAssignments > 0 && taskIds.length > maxConcurrentAssignments) {
        raw.push({
          id: `${ownerKey}:${date}:CONCURRENCY`, ownerKey, taskIds,
          projectIds: [...new Set(allocations.map((entry) => entry.projectId))].sort(),
          startDate: date, finishDate: date, severity: "WARNING", reason: "CONCURRENCY_EXCEEDED",
          concurrentTaskCount: taskIds.length, maxConcurrentAssignments,
        });
      }
    });
  }));
  const grouped = new Map<string, ResourceConflict>();
  raw.sort((left, right) => left.ownerKey.localeCompare(right.ownerKey) || left.startDate.localeCompare(right.startDate)).forEach((conflict) => {
    const groupKey = `${conflict.ownerKey}:${conflict.reason}:${conflict.taskIds.join(",")}`;
    const previous = grouped.get(groupKey);
    if (previous && nextCalendarDate(previous.finishDate) === conflict.startDate) {
      previous.finishDate = conflict.finishDate;
      previous.projectIds = [...new Set([...previous.projectIds, ...conflict.projectIds])].sort();
      previous.allocatedHours = Math.max(previous.allocatedHours ?? 0, conflict.allocatedHours ?? 0) || undefined;
      previous.capacityHours = Math.min(previous.capacityHours ?? Number.POSITIVE_INFINITY, conflict.capacityHours ?? Number.POSITIVE_INFINITY);
      if (!Number.isFinite(previous.capacityHours ?? Number.POSITIVE_INFINITY)) previous.capacityHours = undefined;
      previous.concurrentTaskCount = Math.max(previous.concurrentTaskCount ?? 0, conflict.concurrentTaskCount ?? 0) || undefined;
      return;
    }
    grouped.set(groupKey, { ...conflict });
  });
  return [...grouped.values()].sort((left, right) => left.ownerKey.localeCompare(right.ownerKey) || left.startDate.localeCompare(right.startDate));
};

export const detectResourceConflicts = (
  tasks: ResourceSchedulingTask[],
  calendarMode: GanttCalendarMode = "CALENDAR_DAYS",
): ResourceConflict[] => collectDailyConflicts(tasks, calendarMode);

const dependencyStartDate = (
  predecessor: ScheduledTask,
  successorDuration: number,
  dependency: ResourceScheduleDependency,
  mode: GanttCalendarMode,
) => {
  const lagMinutes = ganttDependencyLagMinutes(dependency);
  const lagDays = lagMinutes === 0 ? 0 : Math.sign(lagMinutes) * Math.ceil(Math.abs(lagMinutes) / GANTT_MINUTES_PER_DAY);
  const type = Number.isInteger(dependency.type) ? dependency.type : 1;
  if (type === 3) return shiftTaskDate(predecessor.startDate, lagDays, mode); // SS
  if (type === 0) return calculateTaskStartDate(shiftTaskDate(predecessor.finishDate, lagDays, mode), successorDuration, mode); // FF
  if (type === 2) return calculateTaskStartDate(shiftTaskDate(predecessor.startDate, lagDays, mode), successorDuration, mode); // SF
  return shiftTaskDate(nextTaskStartDate(predecessor.finishDate, mode), lagDays, mode); // FS
};

type Topology = { order: string[]; issues: ResourceScheduleIssue[] };

const topologicalOrder = (tasks: ResourceSchedulingTask[]): Topology => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const inDegree = new Map(tasks.map((task) => [task.id, 0]));
  const successors = new Map<string, string[]>();
  const issues: ResourceScheduleIssue[] = [];
  tasks.forEach((task) => {
    task.predecessorDependencies.forEach((dependency) => {
      const predecessorId = dependency.predecessorTaskId;
      if (!byId.has(predecessorId) || predecessorId === task.id) {
        issues.push({
          id: `dependency:${task.id}:${predecessorId}`,
          code: "INVALID_DEPENDENCY",
          severity: "ERROR",
          taskIds: [task.id, ...(byId.has(predecessorId) ? [predecessorId] : [])],
          message: `任务「${task.taskName || task.id}」存在无效紧前任务。`,
          suggestion: "修正或删除无效的紧前任务关系后再自动排期。",
        });
        return;
      }
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      successors.set(predecessorId, [...(successors.get(predecessorId) ?? []), task.id]);
    });
  });
  const compare = (leftId: string, rightId: string) => {
    const left = byId.get(leftId)!;
    const right = byId.get(rightId)!;
    return left.sortOrder - right.sortOrder || left.id.localeCompare(right.id);
  };
  const queue = tasks.filter((task) => (inDegree.get(task.id) ?? 0) === 0).map((task) => task.id).sort(compare);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    (successors.get(id) ?? []).forEach((successorId) => {
      const degree = (inDegree.get(successorId) ?? 0) - 1;
      inDegree.set(successorId, degree);
      if (degree === 0) {
        queue.push(successorId);
        queue.sort(compare);
      }
    });
  }
  if (order.length !== tasks.length) {
    const cycleTaskIds = tasks.filter((task) => !order.includes(task.id)).map((task) => task.id);
    issues.push({
      id: `dependency-cycle:${cycleTaskIds.sort().join(",")}`,
      code: "DEPENDENCY_CYCLE",
      severity: "ERROR",
      taskIds: cycleTaskIds,
      message: "紧前任务存在循环依赖，自动排期不会用任意顺序掩盖该错误。",
      suggestion: "解除循环依赖后重新计算网络计划。",
    });
  }
  return { order, issues };
};

const criticalWeights = (tasks: ResourceSchedulingTask[]) => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const successors = new Map<string, string[]>();
  tasks.forEach((task) => task.predecessorDependencies.forEach((dependency) => {
    if (!byId.has(dependency.predecessorTaskId) || dependency.predecessorTaskId === task.id) return;
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

type ParentBounds = { earliestStart: string; latestFinish: string; lockedTaskIds: string[]; targetTaskIds: string[] };

const parentBoundsFor = (
  task: ResourceSchedulingTask,
  byId: Map<string, ResourceSchedulingTask>,
  options: { useRollupDatesAsSeed?: boolean } = {},
) => {
  const bounds: ParentBounds = { earliestStart: "", latestFinish: "", lockedTaskIds: [], targetTaskIds: [] };
  const seen = new Set<string>([task.id]);
  let parentId = task.parentId ?? null;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    const boundaryMode = normalizeBoundaryMode(parent.parentBoundaryMode);
    if (boundaryMode !== "ROLLUP" || options.useRollupDatesAsSeed) {
      if (validDate(parent.startDate)) bounds.earliestStart = dateMax([bounds.earliestStart, parent.startDate]);
      if (validDate(parent.finishDate)) bounds.latestFinish = dateMin([bounds.latestFinish, parent.finishDate]);
      (boundaryMode === "LOCKED" ? bounds.lockedTaskIds : bounds.targetTaskIds).push(parent.id);
    }
    parentId = parent.parentId ?? null;
  }
  return bounds;
};

const taskPriorityCompare = (
  kind: ResourceScheduleCandidateKind,
  weights: Map<string, number>,
) => (left: ResourceSchedulingTask, right: ResourceSchedulingTask) => {
  const leftPriority = Math.max(0, Math.min(1000, Number(left.schedulePriority ?? 500)));
  const rightPriority = Math.max(0, Math.min(1000, Number(right.schedulePriority ?? 500)));
  const leftFloat = Math.max(0, Number(left.totalFloatMinutes ?? Number.POSITIVE_INFINITY));
  const rightFloat = Math.max(0, Number(right.totalFloatMinutes ?? Number.POSITIVE_INFINITY));
  if (kind === "EARLIEST_FINISH") {
    return (weights.get(right.id) ?? 0) - (weights.get(left.id) ?? 0)
      || rightPriority - leftPriority
      || left.startDate.localeCompare(right.startDate)
      || left.sortOrder - right.sortOrder;
  }
  if (kind === "ON_TIME") {
    return left.finishDate.localeCompare(right.finishDate)
      || leftFloat - rightFloat
      || rightPriority - leftPriority
      || left.sortOrder - right.sortOrder;
  }
  if (kind === "RESOURCE_SMOOTHING") {
    return leftFloat - rightFloat
      || rightPriority - leftPriority
      || left.sortOrder - right.sortOrder;
  }
  return left.startDate.localeCompare(right.startDate)
    || rightPriority - leftPriority
    || left.sortOrder - right.sortOrder
    || left.id.localeCompare(right.id);
};

const allocationIssuesFor = (task: ResourceSchedulingTask): ResourceScheduleIssue[] => {
  const duration = normalizeGanttDurationDays(task.durationDays);
  if (!task.isLeaf || duration <= 0) return [];
  return normalizedAssignments(task).flatMap((assignment) => {
    const required = assignment.plannedWorkHours / duration;
    const limit = allocationDailyLimit(assignment);
    if (required <= limit + EPSILON) return [];
    return [{
      id: `allocation:${task.id}:${assignment.ownerKey}`,
      code: "RESOURCE_ASSIGNMENT_EXCEEDS_ALLOCATION" as const,
      severity: "WARNING" as const,
      taskIds: [task.id],
      message: `任务「${task.taskName || task.id}」分配给 ${assignment.ownerKey} 的日工作量超过 ${assignment.unitsPercent}% 分配上限。`,
      suggestion: "增加工期、提高分配比例或拆分任务后再自动排期。",
    }];
  });
};

const missingStartDateIssuesFor = (tasks: ResourceSchedulingTask[]): ResourceScheduleIssue[] => tasks.flatMap((task) => {
  if (!task.isLeaf || normalizeGanttDurationDays(task.durationDays) <= 0 || validDate(task.startDate)) return [];
  return [{
    id: `missing-start:${task.id}`,
    code: "MISSING_START_DATE" as const,
    severity: isLockedTask(task) ? "ERROR" as const : "WARNING" as const,
    taskIds: [task.id],
    message: `任务「${task.taskName || task.id}」没有计划开始时间。`,
    suggestion: isLockedTask(task)
      ? "为手动/锁定任务填写计划开始时间。"
      : "填写计划开始时间，或在父任务计划窗口内使用自动排期。",
  }];
});

const findResourceStartDate = (params: {
  task: ResourceSchedulingTask;
  requestedStartDate: string;
  latestFinishDate: string;
  calendar: ResourceCapacityCalendar;
  mode: GanttCalendarMode;
}) => {
  let candidate = params.requestedStartDate;
  for (let attempt = 0; attempt < MAX_SEARCH_DAYS; attempt += 1) {
    if (!validDate(candidate)) return { startDate: "", finishDate: "", reason: "MISSING_START_DATE" as const };
    const finishDate = calculateTaskFinishDate(candidate, params.task.durationDays, params.mode);
    if (params.latestFinishDate && finishDate > params.latestFinishDate) return { startDate: "", finishDate: "", reason: "PARENT_BOUNDARY_VIOLATION" as const };
    if (params.calendar.canPlace(params.task, candidate, params.mode)) return { startDate: candidate, finishDate, reason: null };
    const next = nextTaskStartDate(candidate, params.mode);
    if (next <= candidate) break;
    candidate = next;
  }
  return { startDate: "", finishDate: "", reason: "RESOURCE_CAPACITY_EXCEEDED" as const };
};

/**
 * Finds the latest feasible allocation before a parent/project completion
 * boundary. This is used for undated automatic work so higher-priority work is
 * protected closest to the boundary instead of every sibling being seeded at
 * the parent's start date.
 */
const findResourceStartDateBackward = (params: {
  task: ResourceSchedulingTask;
  requestedFinishDate: string;
  earliestStartDate: string;
  calendar: ResourceCapacityCalendar;
  mode: GanttCalendarMode;
}) => {
  let candidate = calculateTaskStartDate(params.requestedFinishDate, params.task.durationDays, params.mode);
  for (let attempt = 0; attempt < MAX_SEARCH_DAYS; attempt += 1) {
    if (!validDate(candidate)) return { startDate: "", finishDate: "", reason: "MISSING_START_DATE" as const };
    const finishDate = calculateTaskFinishDate(candidate, params.task.durationDays, params.mode);
    if (params.earliestStartDate && candidate < params.earliestStartDate) {
      return { startDate: "", finishDate: "", reason: "PARENT_BOUNDARY_VIOLATION" as const };
    }
    if (params.calendar.canPlace(params.task, candidate, params.mode)) {
      return { startDate: candidate, finishDate, reason: null };
    }
    const previous = shiftTaskDate(candidate, -1, params.mode);
    if (previous >= candidate) break;
    candidate = previous;
  }
  return { startDate: "", finishDate: "", reason: "RESOURCE_CAPACITY_EXCEEDED" as const };
};

const dependencyIssuesFor = (
  tasks: ScheduledTask[],
  mode: GanttCalendarMode,
): ResourceScheduleIssue[] => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const issues: ResourceScheduleIssue[] = [];
  tasks.forEach((task) => {
    const duration = normalizeGanttDurationDays(task.durationDays);
    task.predecessorDependencies.forEach((dependency) => {
      const predecessor = byId.get(dependency.predecessorTaskId);
      if (!predecessor || !validDate(task.startDate)) return;
      const requiredStart = dependencyStartDate(predecessor, duration, dependency, mode);
      if (requiredStart && task.startDate < requiredStart) {
        issues.push({
          id: `constraint:${task.id}:${predecessor.id}`,
          code: "DEPENDENCY_CONSTRAINT",
          severity: isLockedTask(task) ? "ERROR" : "WARNING",
          taskIds: [predecessor.id, task.id],
          message: `任务「${task.taskName || task.id}」早于紧前任务允许的开始时间。`,
          suggestion: isLockedTask(task) ? "调整固定排期约束或紧前任务关系。" : "调整计划开始时间或紧前任务关系。",
        });
      }
    });
    const bounds = parentBoundsFor(task, byId);
    if (bounds.earliestStart && task.startDate && task.startDate < bounds.earliestStart) {
      issues.push({
        id: `parent-start:${task.id}:${bounds.earliestStart}`,
        code: "PARENT_BOUNDARY_VIOLATION",
        severity: bounds.lockedTaskIds.length > 0 ? "ERROR" : "WARNING",
        taskIds: [task.id, ...bounds.lockedTaskIds, ...bounds.targetTaskIds],
        message: `任务「${task.taskName || task.id}」早于父任务边界开始。`,
        suggestion: "调整子任务开始时间或父任务边界。",
      });
    }
    if (bounds.latestFinish && task.finishDate && task.finishDate > bounds.latestFinish) {
      issues.push({
        id: `parent-finish:${task.id}:${bounds.latestFinish}`,
        code: "PARENT_BOUNDARY_VIOLATION",
        severity: bounds.lockedTaskIds.length > 0 ? "ERROR" : "WARNING",
        taskIds: [task.id, ...bounds.lockedTaskIds, ...bounds.targetTaskIds],
        message: `任务「${task.taskName || task.id}」超出父任务完成边界。`,
        suggestion: "增加父任务可用工期、缩短子任务工期或调整依赖关系。",
      });
    }
  });
  return issues;
};

/**
 * Validates the current plan without trying to move it. This is used after a
 * manual edit so the UI can warn about real schedule interference while still
 * respecting the date entered by the project user.
 */
export const detectResourceScheduleIssues = (
  tasks: ResourceSchedulingTask[],
  mode: GanttCalendarMode = "CALENDAR_DAYS",
): ResourceScheduleIssue[] => {
  const topology = topologicalOrder(tasks);
  const scheduled = tasks.map((task) => ({
    ...task,
    startDate: validDate(task.startDate) ? normalizeTaskStartDate(task.startDate, mode) : "",
    finishDate: validDate(task.finishDate)
      ? task.finishDate
      : validDate(task.startDate) && normalizeGanttDurationDays(task.durationDays) > 0
        ? calculateTaskFinishDate(normalizeTaskStartDate(task.startDate, mode), task.durationDays, mode)
        : "",
  }));
  return [
    ...topology.issues,
    ...missingStartDateIssuesFor(tasks),
    ...tasks.flatMap(allocationIssuesFor),
    ...dependencyIssuesFor(scheduled, mode),
  ];
};

type SchedulingResult = {
  tasks: ScheduledTask[];
  issues: ResourceScheduleIssue[];
  resourceConstrainedTaskIds: string[];
};

const scheduleWithPriority = (params: {
  tasks: ResourceSchedulingTask[];
  mode: GanttCalendarMode;
  kind: ResourceScheduleCandidateKind;
  currentProjectId: string;
  /** Immutable project-level deadline. Unlike expectedEndDate, this is a hard constraint. */
  hardFinishCeiling: string;
  projectFinishCeiling: string;
}): SchedulingResult => {
  const topology = topologicalOrder(params.tasks);
  if (topology.issues.some((issue) => issue.severity === "ERROR")) {
    return {
      tasks: params.tasks.map((task) => ({ ...task, finishDate: task.finishDate })),
      issues: topology.issues,
      resourceConstrainedTaskIds: [],
    };
  }
  const byId = new Map(params.tasks.map((task) => [task.id, task]));
  const weights = criticalWeights(params.tasks);
  const rank = taskPriorityCompare(params.kind, weights);
  const scheduled = new Map<string, ScheduledTask>();
  const calendar = new ResourceCapacityCalendar();
  const issues: ResourceScheduleIssue[] = [...topology.issues, ...params.tasks.flatMap(allocationIssuesFor)];
  const resourceConstrainedTaskIds = new Set<string>();

  params.tasks.filter((task) => !isMovableTask(task)).forEach((task) => {
    const normalizedStart = validDate(task.startDate) ? normalizeTaskStartDate(task.startDate, params.mode) : "";
    const duration = normalizeGanttDurationDays(task.durationDays);
    const finishDate = validDate(task.finishDate)
      ? task.finishDate
      : normalizedStart && duration > 0 ? calculateTaskFinishDate(normalizedStart, duration, params.mode) : "";
    scheduled.set(task.id, { ...task, startDate: normalizedStart, finishDate });
    if (normalizedStart && finishDate) calendar.addTask(task, normalizedStart, params.mode);
  });

  const unscheduled = new Set(params.tasks.filter(isMovableTask).map((task) => task.id));
  while (unscheduled.size > 0) {
    const ready = [...unscheduled]
      .map((id) => byId.get(id)!)
      .filter((task) => task.predecessorDependencies.every((dependency) => !byId.has(dependency.predecessorTaskId) || scheduled.has(dependency.predecessorTaskId)))
      .sort((left, right) => {
        const leftBounds = parentBoundsFor(left, byId, { useRollupDatesAsSeed: !validDate(left.startDate) });
        const rightBounds = parentBoundsFor(right, byId, { useRollupDatesAsSeed: !validDate(right.startDate) });
        const leftEffectiveFinish = dateMin([
          leftBounds.latestFinish,
          left.projectId === params.currentProjectId ? params.hardFinishCeiling : "",
        ]);
        const rightEffectiveFinish = dateMin([
          rightBounds.latestFinish,
          right.projectId === params.currentProjectId ? params.hardFinishCeiling : "",
        ]);
        const leftBackScheduled = !validDate(left.startDate)
          && !validDate(left.resourceNotBeforeDate)
          && left.predecessorDependencies.length === 0
          && validDate(leftEffectiveFinish);
        const rightBackScheduled = !validDate(right.startDate)
          && !validDate(right.resourceNotBeforeDate)
          && right.predecessorDependencies.length === 0
          && validDate(rightEffectiveFinish);
        if (leftBackScheduled && rightBackScheduled) {
          return Math.max(0, Number(right.schedulePriority ?? 500)) - Math.max(0, Number(left.schedulePriority ?? 500))
            || left.sortOrder - right.sortOrder
            || left.id.localeCompare(right.id);
        }
        return rank(left, right);
      });
    const task = ready[0];
    if (!task) {
      const stuckTaskIds = [...unscheduled];
      issues.push({
        id: `unscheduled:${stuckTaskIds.sort().join(",")}`,
        code: "DEPENDENCY_CYCLE",
        severity: "ERROR",
        taskIds: stuckTaskIds,
        message: "存在无法解析的紧前任务顺序，自动排期已停止。",
        suggestion: "检查循环依赖或缺失的紧前任务。",
      });
      break;
    }
    unscheduled.delete(task.id);
    const duration = normalizeGanttDurationDays(task.durationDays);
    const dependencies = task.predecessorDependencies
      .map((dependency) => ({ dependency, predecessor: scheduled.get(dependency.predecessorTaskId) }))
      .filter((item): item is { dependency: ResourceScheduleDependency; predecessor: ScheduledTask } => Boolean(item.predecessor));
    const dependencyStarts = dependencies.map(({ dependency, predecessor }) => dependencyStartDate(predecessor, duration, dependency, params.mode));
    // Summary rows normally roll up from their children. For an undated child,
    // an existing parent window is still useful as an initial scheduling seed.
    // It becomes a target constraint for this automatic calculation only.
    const bounds = parentBoundsFor(task, byId, { useRollupDatesAsSeed: !validDate(task.startDate) });
    const baseStart = normalizeTaskStartDate(task.startDate, params.mode);
    const notBefore = validDate(task.resourceNotBeforeDate) ? normalizeTaskStartDate(task.resourceNotBeforeDate!, params.mode) : "";
    const hardFinishCeiling = task.projectId === params.currentProjectId ? params.hardFinishCeiling : "";
    const effectiveLatestFinish = dateMin([bounds.latestFinish, hardFinishCeiling]);
    const shouldScheduleBackward = !baseStart
      && !notBefore
      && dependencyStarts.length === 0
      && validDate(effectiveLatestFinish);
    const requestedStartDate = dateMax([baseStart, notBefore, bounds.earliestStart, ...dependencyStarts]);
    if (!requestedStartDate && !shouldScheduleBackward) {
      scheduled.set(task.id, { ...task, startDate: "", finishDate: "" });
      continue;
    }
    const smoothingCeiling = params.kind === "RESOURCE_SMOOTHING" && task.projectId === params.currentProjectId
      ? params.projectFinishCeiling
      : "";
    // Resource smoothing may consume only the task's calculated float and may
    // never move the current project beyond its original completion date.
    const latestFinishDate = dateMin([effectiveLatestFinish, smoothingCeiling, task.lateFinishDate]);
    const placement = shouldScheduleBackward
      ? findResourceStartDateBackward({
        task,
        requestedFinishDate: latestFinishDate || effectiveLatestFinish,
        earliestStartDate: bounds.earliestStart,
        calendar,
        mode: params.mode,
      })
      : findResourceStartDate({ task, requestedStartDate, latestFinishDate, calendar, mode: params.mode });
    if (!placement.startDate) {
      const code = params.kind === "RESOURCE_SMOOTHING" ? "RESOURCE_SMOOTHING_LIMIT"
        : hardFinishCeiling ? "PROJECT_HARD_FINISH_VIOLATION"
        : placement.reason === "PARENT_BOUNDARY_VIOLATION" ? "PARENT_BOUNDARY_VIOLATION"
          : placement.reason === "MISSING_START_DATE" ? "MISSING_START_DATE"
            : "RESOURCE_CAPACITY_EXCEEDED";
      issues.push({
        id: `placement:${task.id}:${code}`,
        code,
        severity: code === "PROJECT_HARD_FINISH_VIOLATION" || (code === "PARENT_BOUNDARY_VIOLATION" && bounds.lockedTaskIds.length > 0) ? "ERROR" : "WARNING",
        taskIds: [task.id, ...bounds.lockedTaskIds, ...bounds.targetTaskIds],
        message: code === "RESOURCE_SMOOTHING_LIMIT"
          ? `任务「${task.taskName || task.id}」在不延长项目完工日期的前提下无法消除资源冲突。`
          : code === "PROJECT_HARD_FINISH_VIOLATION"
            ? `任务「${task.taskName || task.id}」无法在项目硬完成时间 ${hardFinishCeiling} 前满足依赖和资源约束。`
            : code === "PARENT_BOUNDARY_VIOLATION"
            ? `任务「${task.taskName || task.id}」无法在父任务边界内满足依赖和资源约束。`
            : `任务「${task.taskName || task.id}」没有可用的资源容量排期位置。`,
        suggestion: "调整负责人容量、工期、紧前关系或父任务边界。",
      });
      const fallbackStart = normalizeTaskStartDate(task.startDate, params.mode);
      const fallbackFinish = validDate(task.finishDate) ? task.finishDate : calculateTaskFinishDate(fallbackStart, duration, params.mode);
      scheduled.set(task.id, { ...task, startDate: fallbackStart, finishDate: fallbackFinish });
      if (fallbackStart && fallbackFinish) calendar.addTask(task, fallbackStart, params.mode);
      continue;
    }
    const placed = { ...task, startDate: placement.startDate, finishDate: placement.finishDate };
    if (
      (shouldScheduleBackward && placement.finishDate !== bounds.latestFinish)
      || (!shouldScheduleBackward && placement.startDate !== requestedStartDate)
    ) {
      resourceConstrainedTaskIds.add(task.id);
    }
    scheduled.set(task.id, placed);
    calendar.addTask(placed, placed.startDate, params.mode);
  }
  params.tasks.filter((task) => !scheduled.has(task.id)).forEach((task) => {
    scheduled.set(task.id, { ...task, finishDate: task.finishDate });
  });
  const scheduledTasks = params.tasks.map((task) => scheduled.get(task.id)!);
  const allIssues = [...issues, ...missingStartDateIssuesFor(scheduledTasks), ...dependencyIssuesFor(scheduledTasks, params.mode)];
  return {
    tasks: scheduledTasks,
    issues: [...new Map(allIssues.map((issue) => [issue.id, issue])).values()],
    resourceConstrainedTaskIds: [...resourceConstrainedTaskIds],
  };
};

const snapshotPayload = (tasks: ResourceSchedulingTask[]) => tasks
  .map((task) => ({
    id: task.id,
    projectId: task.projectId,
    parentId: task.parentId ?? null,
    startDate: task.startDate,
    finishDate: task.finishDate,
    durationDays: task.durationDays,
    estimatedWorkHours: task.estimatedWorkHours ?? 0,
    progress: task.progress,
    taskMode: task.taskMode,
    parentBoundaryMode: task.parentBoundaryMode ?? "ROLLUP",
    schedulePriority: task.schedulePriority ?? 500,
    effortDriven: Boolean(task.effortDriven),
    parallelizable: Boolean(task.parallelizable),
    resourceNotBeforeDate: task.resourceNotBeforeDate || "",
    lateFinishDate: task.lateFinishDate || "",
    ownerAssignments: normalizedAssignments(task).map((assignment) => ({ ...assignment })).sort((left, right) => left.ownerKey.localeCompare(right.ownerKey)),
    predecessorDependencies: task.predecessorDependencies,
  }))
  .sort((left, right) => left.id.localeCompare(right.id));

export const resourceScheduleSnapshotHash = (tasks: ResourceSchedulingTask[]) => (
  createHash("sha256").update(JSON.stringify(snapshotPayload(tasks))).digest("hex")
);

const projectCompletionDate = (tasks: ResourceSchedulingTask[], projectId: string) => (
  tasks
    .filter((task) => task.projectId === projectId && task.isLeaf && validDate(task.finishDate))
    .map((task) => task.finishDate)
    .sort()
    .at(-1) ?? ""
);

const metricsFor = (
  original: ResourceSchedulingTask[],
  scheduled: ResourceSchedulingTask[],
  expectedEndDate: string,
  originalConflicts: ResourceConflict[],
  calendarMode: GanttCalendarMode,
): ResourceScheduleMetrics => {
  const originalById = new Map(original.map((task) => [task.id, task]));
  const currentTasks = scheduled.filter((task) => task.isCurrentProject && task.isLeaf && validDate(task.finishDate));
  const completionDate = currentTasks.map((task) => task.finishDate).sort().at(-1) ?? "";
  const delayedDays = expectedEndDate && completionDate > expectedEndDate ? dateDiff(expectedEndDate, completionDate) : 0;
  let movedTaskCount = 0;
  let totalShiftDays = 0;
  scheduled.forEach((task) => {
    const originalTask = originalById.get(task.id);
    if (!originalTask || originalTask.startDate === task.startDate) return;
    movedTaskCount += 1;
    totalShiftDays += Math.abs(dateDiff(originalTask.startDate, task.startDate));
  });
  const remaining = detectResourceConflicts(scheduled, calendarMode);
  return {
    completionDate,
    delayedDays,
    movedTaskCount,
    totalShiftDays,
    resolvedConflictCount: Math.max(0, originalConflicts.length - remaining.length),
    remainingCapacityOverloadCount: remaining.filter((conflict) => conflict.reason === "CAPACITY_EXCEEDED").length,
  };
};

export const applyResourceScheduleCandidate = (
  tasks: ResourceSchedulingTask[],
  candidate: Pick<ResourceScheduleCandidate, "changes">,
) => {
  const changes = new Map(candidate.changes.map((change) => [change.taskId, change]));
  return tasks.map((task) => {
    const change = changes.get(task.id);
    return change ? {
      ...task,
      startDate: change.startDate,
      finishDate: change.finishDate,
      ...(change.taskMode ? { taskMode: change.taskMode } : {}),
    } : task;
  });
};

const normalizeModeOverride = (value: unknown): ResourceScheduleModeOverride => (
  value === "AUTO" || value === "DURATION_FORWARD" || value === "DURATION_BACKWARD"
    ? value
    : "PRESERVE"
);

const scopedSchedulingTasks = (params: {
  tasks: ResourceSchedulingTask[];
  currentProjectId: string;
  scopeTaskIds: Set<string>;
  modeOverride: ResourceScheduleModeOverride;
}) => params.tasks.map((task) => {
  if (task.projectId !== params.currentProjectId || !task.isLeaf) return task;
  if (!params.scopeTaskIds.has(task.id)) {
    // Automatic tasks outside the requested branch are fixed anchors for this
    // run. Their dates still consume the responsible person's capacity.
    return { ...task, taskMode: "DATES_FIXED" };
  }
  if (task.progress > 0 || normalizeGanttScheduleMode(task.taskMode) === "DATES_FIXED") return task;
  if (params.modeOverride === "PRESERVE") return task;
  // The scheduler calculates dates using AUTO semantics, while the selected
  // forward/backward mode is persisted only after the user applies a preview.
  return { ...task, taskMode: "AUTO" };
});

const scopedSchedulingPrerequisites = (params: {
  tasks: ResourceSchedulingTask[];
  currentProjectId: string;
  scopeTaskIds: Set<string>;
  modeOverride: ResourceScheduleModeOverride;
  hardFinishDate: string;
}) => {
  const byId = new Map(params.tasks.map((task) => [task.id, task]));
  return params.tasks.flatMap((task): ResourceScheduleIssue[] => {
    if (task.projectId !== params.currentProjectId || !task.isLeaf || !params.scopeTaskIds.has(task.id)) return [];
    if (task.progress > 0 || normalizeGanttDurationDays(task.durationDays) <= 0) return [];
    const becomesAutomatic = normalizeGanttScheduleMode(task.taskMode) === "AUTO"
      || params.modeOverride !== "PRESERVE" && normalizeGanttScheduleMode(task.taskMode) !== "DATES_FIXED";
    if (!becomesAutomatic) return [];
    const assignments = normalizedAssignments(task);
    const issues: ResourceScheduleIssue[] = [];
    if (assignments.length !== 1) {
      issues.push({
        id: `missing-owner:${task.id}`,
        code: "MISSING_RESPONSIBLE_PERSON",
        severity: "ERROR",
        taskIds: [task.id],
        message: `任务「${task.taskName || task.id}」缺少唯一负责人，不能自动排期。`,
        suggestion: "为末级任务指定一名项目组成员后重新计算。",
      });
    }
    const bounds = parentBoundsFor(task, byId, { useRollupDatesAsSeed: true });
    const hasDependencyAnchor = task.predecessorDependencies.some((dependency) => {
      const predecessor = byId.get(dependency.predecessorTaskId);
      return Boolean(predecessor && validDate(predecessor.finishDate));
    });
    const hasAnchor = validDate(task.startDate)
      || validDate(task.resourceNotBeforeDate)
      || hasDependencyAnchor
      || validDate(bounds.earliestStart)
      || validDate(bounds.latestFinish)
      || validDate(params.hardFinishDate);
    if (!hasAnchor) {
      issues.push({
        id: `missing-anchor:${task.id}`,
        code: "MISSING_SCHEDULE_ANCHOR",
        severity: "ERROR",
        taskIds: [task.id],
        message: `任务「${task.taskName || task.id}」缺少计划开始、紧前任务或父级日期边界，无法确定排期锚点。`,
        suggestion: "补充计划开始、紧前任务或父级计划窗口后重新自动排期。",
      });
    }
    return issues;
  });
};

export const createResourceScheduleCandidates = (params: {
  tasks: ResourceSchedulingTask[];
  currentProjectId: string;
  calendarMode: GanttCalendarMode;
  /** Soft project target, used to show completion delay. */
  expectedEndDate: string;
  /** Hard project deadline. Candidate dates cannot exceed this date. */
  hardFinishDate?: string;
  /** Leaf task ids included in this automatic scheduling run. */
  scopeTaskIds?: Iterable<string>;
  /** Optional bulk scheduling mode for eligible descendant leaves. */
  modeOverride?: ResourceScheduleModeOverride;
}): ResourceScheduleCandidateResult => {
  const snapshotHash = resourceScheduleSnapshotHash(params.tasks);
  const currentProjectTaskIds = new Set(params.tasks.filter((task) => task.projectId === params.currentProjectId).map((task) => task.id));
  const requestedScope = new Set(params.scopeTaskIds ?? currentProjectTaskIds);
  const scopeTaskIds = new Set(
    [...requestedScope].filter((taskId) => currentProjectTaskIds.has(taskId)),
  );
  const modeOverride = normalizeModeOverride(params.modeOverride);
  const hardFinishCeiling = validDate(params.hardFinishDate) ? params.hardFinishDate! : "";
  const schedulingTasks = scopedSchedulingTasks({
    tasks: params.tasks,
    currentProjectId: params.currentProjectId,
    scopeTaskIds,
    modeOverride,
  });
  const prerequisites = scopedSchedulingPrerequisites({
    tasks: params.tasks,
    currentProjectId: params.currentProjectId,
    scopeTaskIds,
    modeOverride,
    hardFinishDate: hardFinishCeiling,
  });
  const relevantConflicts = (tasks: ResourceSchedulingTask[]) => detectResourceConflicts(tasks, params.calendarMode)
    .filter((conflict) => conflict.taskIds.some((taskId) => scopeTaskIds.has(taskId)));
  const conflicts = relevantConflicts(params.tasks);
  const allCurrentIssues = detectResourceScheduleIssues(params.tasks, params.calendarMode);
  const currentIssues = [
    ...allCurrentIssues.filter((issue) => issue.taskIds.some((taskId) => scopeTaskIds.has(taskId))),
    ...prerequisites,
  ];
  const projectFinishCeiling = projectCompletionDate(params.tasks, params.currentProjectId);
  const candidates = ([
    ["MINIMAL_CHANGE", "最少改动", "保留现有任务顺序和计划日期，仅在负责人容量或紧前关系无法满足时向后安排。"],
    ["EARLIEST_FINISH", "最早完成", "优先安排关键链路、较长任务和高优先级任务，在满足负责人容量的前提下尽量缩短总工期。"],
    ["ON_TIME", "按期优先", "优先保护临近目标完成日期、低浮动和高优先级任务，降低超期风险。"],
    ["RESOURCE_SMOOTHING", "资源平滑", "仅在任务总浮动和既有项目完工日期范围内平移自动任务，不延长项目总工期。"],
  ] as const).map(([kind, title, explanation]) => {
    const scheduledResult = scheduleWithPriority({
      tasks: schedulingTasks,
      mode: params.calendarMode,
      kind,
      currentProjectId: params.currentProjectId,
      hardFinishCeiling,
      projectFinishCeiling,
    });
    const changes = scheduledResult.tasks
      .filter((task) => {
        const original = params.tasks.find((item) => item.id === task.id);
        return task.isCurrentProject && scopeTaskIds.has(task.id) && Boolean(original)
          && (
            task.startDate !== original!.startDate
            || task.finishDate !== original!.finishDate
            || (modeOverride !== "PRESERVE"
              && normalizeGanttScheduleMode(original!.taskMode) !== "DATES_FIXED"
              && original!.progress === 0)
          );
      })
      .map((task) => {
        const original = params.tasks.find((item) => item.id === task.id)!;
        return {
          taskId: task.id,
          startDate: task.startDate,
          finishDate: task.finishDate,
          ...(modeOverride !== "PRESERVE"
            && normalizeGanttScheduleMode(original.taskMode) !== "DATES_FIXED"
            && original.progress === 0
            ? { taskMode: modeOverride }
            : {}),
        };
      });
    const remainingConflicts = relevantConflicts(scheduledResult.tasks);
    const metrics = metricsFor(params.tasks, scheduledResult.tasks, params.expectedEndDate, conflicts, params.calendarMode);
    const remainingIssues = [
      ...scheduledResult.issues.filter((issue) => issue.taskIds.some((taskId) => scopeTaskIds.has(taskId))),
      ...prerequisites,
    ];
    const hasBlockingIssue = remainingIssues.some((issue) => issue.severity === "ERROR");
    return {
      id: `${snapshotHash}:${kind}`,
      kind,
      title,
      explanation,
      applicable: changes.length > 0 && !hasBlockingIssue,
      snapshotHash,
      changes,
      remainingConflicts,
      issues: remainingIssues,
      resourceConstrainedTaskIds: scheduledResult.resourceConstrainedTaskIds,
      metrics,
    } satisfies ResourceScheduleCandidate;
  });
  return { snapshotHash, conflicts, issues: currentIssues, candidates };
};
