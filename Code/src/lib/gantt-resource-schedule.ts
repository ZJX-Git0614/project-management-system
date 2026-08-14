import { createHash } from "node:crypto";

import {
  GANTT_HOURS_PER_DAY,
  calculateTaskDurationDays,
  calculateTaskFinishDate,
  calculateTaskStartDate,
  ganttTaskWorkSlots,
  nextTaskStartDate,
  normalizeGanttDurationDays,
  normalizeTaskStartDate,
  shiftTaskDate,
  type GanttCalendarMode,
} from "@/lib/gantt-calendar";
import {
  GANTT_MINUTES_PER_DAY,
  calculateGanttCpm,
  ganttDependencyLagMinutes,
  ganttFloatDays,
  type GanttCpmMetrics,
} from "@/lib/gantt-cpm";
import {
  createGanttDurationSuggestions,
  type GanttDurationSuggestion,
  type GanttDurationSuggestionIssue,
} from "@/lib/gantt-duration-suggestions";
import {
  GANTT_RELATIVE_T0_ANCHOR,
  abstractDateFromGanttOffset,
  formatGanttRelativeOffset,
  ganttOffsetFromAbstractDate,
  isGanttRelativeOffset,
} from "@/lib/gantt-relative-time";
import { isGanttFsDependency, normalizeGanttScheduleMode } from "@/lib/gantt-planning-rules";
import { buildGanttLeafScheduleNetwork } from "@/lib/gantt-schedule-network";

export type ResourceScheduleTaskMode =
  | "AUTO"
  | "DURATION_FORWARD"
  | "DURATION_BACKWARD"
  | "DATES_FIXED"
  // Kept only for restoring snapshots created by earlier releases.
  | "MANUAL"
  | "LOCKED"
  | "FIXED";
export type ParentBoundaryMode = "ROLLUP" | "LOCKED";
/**
 * There is intentionally one scheduling policy. The preview/apply split is a
 * safety boundary, not a choice between different algorithms.
 */
export const FORMAL_RESOURCE_SCHEDULE_CANDIDATE_KIND = "FORMAL" as const;
export type ResourceScheduleCandidateKind = typeof FORMAL_RESOURCE_SCHEDULE_CANDIDATE_KIND;
export type ResourceScheduleModeOverride = "PRESERVE" | "AUTO" | "DURATION_FORWARD" | "DURATION_BACKWARD";
export type ResourceScheduleIssueCode =
  | "DEPENDENCY_CYCLE"
  | "INVALID_DEPENDENCY"
  | "UNSUPPORTED_DEPENDENCY_TYPE"
  | "DEPENDENCY_CONSTRAINT"
  | "MISSING_START_DATE"
  | "MISSING_DURATION"
  | "PARENT_BOUNDARY_VIOLATION"
  | "PROJECT_HARD_FINISH_VIOLATION"
  | "RESOURCE_CAPACITY_EXCEEDED"
  | "RESOURCE_ASSIGNMENT_EXCEEDS_ALLOCATION"
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
  relativeStartOffsetDays?: number | null;
  relativeFinishOffsetDays?: number | null;
  durationDays: number;
  durationMinutes?: number;
  isMilestone?: boolean;
  estimatedWorkHours?: number;
  progress: number;
  actualStartDate?: string;
  actualEndDate?: string;
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
  relativeStartOffsetDays?: number | null;
  relativeFinishOffsetDays?: number | null;
  /**
   * A zero-duration leaf can receive a deterministic duration proposal from
   * its parent window. It becomes formal only when the scheduling candidate is
   * applied, together with its calculated dates.
   */
  durationDays?: number;
  durationMinutes?: number;
  estimatedWorkHours?: number;
  /** Optional mode change requested by a scoped automatic scheduling run. */
  taskMode?: ResourceScheduleTaskMode;
}

export interface ResourceScheduleMetrics {
  completionDate: string;
  relativeCompletionOffsetDays?: number | null;
  delayedDays: number;
  movedTaskCount: number;
  totalShiftDays: number;
  resolvedConflictCount: number;
  remainingCapacityOverloadCount: number;
}

/**
 * A derived, resource-caused serial relation. It is deliberately kept
 * separate from a user-entered FS dependency: it explains why capacity
 * leveling placed two otherwise independent tasks in sequence.
 */
export interface ResourceCriticalChainLink {
  predecessorTaskId: string;
  successorTaskId: string;
  ownerKey: string;
}

export interface ResourceScheduleCandidate {
  id: string;
  kind: ResourceScheduleCandidateKind;
  title: string;
  explanation: string;
  /** True when no concrete project T0 exists and all dates are T0 offsets. */
  relativeSchedule: boolean;
  applicable: boolean;
  snapshotHash: string;
  changes: ResourceScheduleChange[];
  remainingConflicts: ResourceConflict[];
  issues: ResourceScheduleIssue[];
  /** Tasks whose placement was constrained by resource capacity in this candidate. */
  resourceConstrainedTaskIds: string[];
  /** Blue, derived serial chain introduced by resource capacity leveling. */
  resourceCriticalChainTaskIds: string[];
  resourceCriticalChainLinks: ResourceCriticalChainLink[];
  /** Critical path after resource leveling and final CPM recalculation. */
  criticalTaskIds: string[];
  /** User-visible evidence for why each task landed on its proposed dates. */
  taskExplanations: ResourceScheduleTaskExplanation[];
  metrics: ResourceScheduleMetrics;
}

export type ResourceScheduleReasonCode =
  | "DEPENDENCY"
  | "RESOURCE_CAPACITY"
  | "HARD_BOUNDARY"
  | "INITIAL_FLOAT"
  | "DOWNSTREAM_IMPACT"
  | "BUSINESS_PRIORITY"
  | "BACKWARD_PLACEMENT"
  | "PRESERVED_DATE"
  | "RESOURCE_CRITICAL_CHAIN"
  | "CRITICAL_PATH";

export interface ResourceScheduleTaskExplanation {
  taskId: string;
  startDate: string;
  finishDate: string;
  relativeStartOffsetDays?: number | null;
  relativeFinishOffsetDays?: number | null;
  initialTotalFloatDays: number | null;
  finalTotalFloatDays: number | null;
  isCritical: boolean;
  resourceConstrained: boolean;
  resourceCritical: boolean;
  reasonCodes: ResourceScheduleReasonCode[];
  summary: string;
  details: string[];
}

export interface ResourceScheduleCandidateResult {
  snapshotHash: string;
  conflicts: ResourceConflict[];
  issues: ResourceScheduleIssue[];
  durationSuggestions: GanttDurationSuggestion[];
  durationSuggestionIssues: GanttDurationSuggestionIssue[];
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
  normalizeGanttScheduleMode(task.taskMode) === "DATES_FIXED" || task.progress > 0
);
const isMovableTask = (task: ResourceSchedulingTask) => (
  task.isCurrentProject
  && task.isLeaf
  && !isLockedTask(task)
  && normalizeGanttDurationDays(task.durationDays) > 0
);
const normalizeBoundaryMode = (value: unknown): ParentBoundaryMode => (
  value === "LOCKED" ? "LOCKED" : "ROLLUP"
);
const dateMax = (values: Array<string | null | undefined>) => values.filter(validDate).sort().at(-1) ?? "";
const dateMin = (values: Array<string | null | undefined>) => values.filter(validDate).sort().at(0) ?? "";
const dateDiff = (startDate: string, finishDate: string) => {
  if (!validDate(startDate) || !validDate(finishDate)) return 0;
  return Math.round((Date.parse(`${finishDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
};
const lockedBoundaryOvertimeHours = (
  task: Pick<ResourceSchedulingTask, "finishDate">,
  latestFinish: string,
  mode: GanttCalendarMode,
) => {
  if (!validDate(task.finishDate) || !validDate(latestFinish) || task.finishDate <= latestFinish) return 0;
  const firstOvertimeDate = nextTaskStartDate(latestFinish, mode);
  if (!validDate(firstOvertimeDate) || firstOvertimeDate > task.finishDate) return 0;
  return Math.round(calculateTaskDurationDays(firstOvertimeDate, task.finishDate, mode) * GANTT_HOURS_PER_DAY * 100) / 100;
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
  dependency: ResourceScheduleDependency,
  mode: GanttCalendarMode,
) => {
  const lagMinutes = ganttDependencyLagMinutes(dependency);
  const lagDays = lagMinutes === 0 ? 0 : Math.sign(lagMinutes) * Math.ceil(Math.abs(lagMinutes) / GANTT_MINUTES_PER_DAY);
  return shiftTaskDate(nextTaskStartDate(predecessor.finishDate, mode), lagDays, mode);
};

const dependencyFinishDate = (
  successor: ScheduledTask,
  dependency: ResourceScheduleDependency,
  mode: GanttCalendarMode,
) => {
  const lagMinutes = ganttDependencyLagMinutes(dependency);
  const lagDays = lagMinutes === 0 ? 0 : Math.sign(lagMinutes) * Math.ceil(Math.abs(lagMinutes) / GANTT_MINUTES_PER_DAY);
  return shiftTaskDate(successor.startDate, -(lagDays + 1), mode);
};

type Topology = { order: string[]; issues: ResourceScheduleIssue[] };

const topologicalOrder = (tasks: ResourceSchedulingTask[]): Topology => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const inDegree = new Map(tasks.map((task) => [task.id, 0]));
  const successors = new Map<string, string[]>();
  const issues: ResourceScheduleIssue[] = [];
  tasks.forEach((task) => {
    task.predecessorDependencies.forEach((dependency) => {
      if (!isGanttFsDependency(dependency)) {
        issues.push({
          id: `unsupported-dependency:${task.id}:${dependency.predecessorTaskId}:${dependency.type ?? "default"}`,
          code: "UNSUPPORTED_DEPENDENCY_TYPE",
          severity: "ERROR",
          taskIds: [task.id, dependency.predecessorTaskId].filter((taskId) => byId.has(taskId)),
          message: `任务「${task.taskName || task.id}」使用了当前排期引擎不支持的紧前关系。`,
          suggestion: "当前仅支持完成-开始（FS）关系，请先调整关系类型后再自动排期或发布基线。",
        });
        return;
      }
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
  tasks.forEach((task) => task.predecessorDependencies.filter(isGanttFsDependency).forEach((dependency) => {
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

type ParentBounds = {
  /** Explicit LOCKED boundaries. Only these may block scheduling or baseline release. */
  earliestStart: string;
  latestFinish: string;
  lockedTaskIds: string[];
};

const parentBoundsFor = (
  task: ResourceSchedulingTask,
  byId: Map<string, ResourceSchedulingTask>,
) => {
  const bounds: ParentBounds = {
    earliestStart: "",
    latestFinish: "",
    lockedTaskIds: [],
  };
  const seen = new Set<string>([task.id]);
  let parentId = task.parentId ?? null;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    const boundaryMode = normalizeBoundaryMode(parent.parentBoundaryMode);
    if (boundaryMode === "LOCKED") {
      if (validDate(parent.startDate)) bounds.earliestStart = dateMax([bounds.earliestStart, parent.startDate]);
      if (validDate(parent.finishDate)) bounds.latestFinish = dateMin([bounds.latestFinish, parent.finishDate]);
      bounds.lockedTaskIds.push(parent.id);
    }
    parentId = parent.parentId ?? null;
  }
  return bounds;
};

/**
 * Formal scheduling order after the dependency graph has made tasks ready:
 * least float first, then largest unlocked downstream workload, then the
 * explicit business priority, then stable WBS order. This is deliberately
 * deterministic so a preview can be reproduced from the same snapshot.
 */
const formalTaskPriorityCompare = (weights: Map<string, number>) => (
  left: ResourceSchedulingTask,
  right: ResourceSchedulingTask,
) => {
  const leftPriority = Math.max(0, Math.min(1000, Number(left.schedulePriority ?? 500)));
  const rightPriority = Math.max(0, Math.min(1000, Number(right.schedulePriority ?? 500)));
  const leftFloat = Number.isFinite(Number(left.totalFloatMinutes))
    ? Number(left.totalFloatMinutes)
    : Number.POSITIVE_INFINITY;
  const rightFloat = Number.isFinite(Number(right.totalFloatMinutes))
    ? Number(right.totalFloatMinutes)
    : Number.POSITIVE_INFINITY;
  const strategic = leftFloat - rightFloat
    || (weights.get(right.id) ?? 0) - (weights.get(left.id) ?? 0)
    || rightPriority - leftPriority;
  if (strategic !== 0) return strategic;
  return left.sortOrder - right.sortOrder
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
    task.predecessorDependencies.filter(isGanttFsDependency).forEach((dependency) => {
      const predecessor = byId.get(dependency.predecessorTaskId);
      if (!predecessor || !validDate(task.startDate)) return;
      const requiredStart = dependencyStartDate(predecessor, dependency, mode);
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
        severity: "ERROR",
        taskIds: [task.id, ...bounds.lockedTaskIds],
        message: `任务「${task.taskName || task.id}」早于父任务锁定边界开始。`,
        suggestion: "调整子任务开始时间或解除父任务锁定边界。",
      });
    }
    if (bounds.latestFinish && task.finishDate && task.finishDate > bounds.latestFinish) {
      const overtimeHours = lockedBoundaryOvertimeHours(task, bounds.latestFinish, mode);
      issues.push({
        id: `parent-finish:${task.id}:${bounds.latestFinish}`,
        code: "PARENT_BOUNDARY_VIOLATION",
        severity: "ERROR",
        taskIds: [task.id, ...bounds.lockedTaskIds],
        message: `任务「${task.taskName || task.id}」超出父任务锁定完成边界${overtimeHours > 0 ? `；维持锁定边界需要加班 +${overtimeHours}h` : ""}。`,
        suggestion: overtimeHours > 0
          ? `方案 A：加班 +${overtimeHours}h，保持父任务锁定边界；方案 B：改派给同角色且当前空闲的项目成员，影响为负责人变更及资源链重新计算；方案 C：扩大父任务边界。`
          : "增加父任务可用工期、缩短子任务工期或解除父任务锁定边界。",
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
  const networkTasks = buildGanttLeafScheduleNetwork(tasks).tasks;
  const topology = topologicalOrder(networkTasks);
  const scheduled = networkTasks.map((task) => ({
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
    ...missingStartDateIssuesFor(networkTasks),
    ...networkTasks.flatMap(allocationIssuesFor),
    ...dependencyIssuesFor(scheduled, mode),
  ];
};

type SchedulingResult = {
  tasks: ScheduledTask[];
  issues: ResourceScheduleIssue[];
  resourceConstrainedTaskIds: string[];
};

type ResourceScheduleDirection = "AUTO" | "FORWARD" | "BACKWARD";

const scheduleDirectionFor = (modeOverride: ResourceScheduleModeOverride): ResourceScheduleDirection => {
  if (modeOverride === "DURATION_FORWARD") return "FORWARD";
  if (modeOverride === "DURATION_BACKWARD") return "BACKWARD";
  return "AUTO";
};

const scheduleWithPriority = (params: {
  tasks: ResourceSchedulingTask[];
  mode: GanttCalendarMode;
  currentProjectId: string;
  /** Project T0. Forward scheduling never starts current-project work before it. */
  projectStartDate: string;
  /** Immutable project-level deadline. Unlike expectedEndDate, this is a hard constraint. */
  hardFinishCeiling: string;
  direction: ResourceScheduleDirection;
  /** First CPM pass deliberately ignores responsible-person capacity. */
  ignoreResourceCapacity?: boolean;
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
  const successorsByPredecessor = new Map<string, Array<{
    successorId: string;
    dependency: ResourceScheduleDependency;
  }>>();
  params.tasks.forEach((successor) => {
    successor.predecessorDependencies.filter(isGanttFsDependency).forEach((dependency) => {
      if (!byId.has(dependency.predecessorTaskId) || dependency.predecessorTaskId === successor.id) return;
      successorsByPredecessor.set(dependency.predecessorTaskId, [
        ...(successorsByPredecessor.get(dependency.predecessorTaskId) ?? []),
        { successorId: successor.id, dependency },
      ]);
    });
  });
  const weights = criticalWeights(params.tasks);
  const rank = formalTaskPriorityCompare(weights);
  const scheduled = new Map<string, ScheduledTask>();
  const calendar = new ResourceCapacityCalendar();
  const projectStartAnchor = validDate(params.projectStartDate)
    ? normalizeTaskStartDate(params.projectStartDate, params.mode)
    : "";
  const issues: ResourceScheduleIssue[] = [...topology.issues, ...params.tasks.flatMap(allocationIssuesFor)];
  const resourceConstrainedTaskIds = new Set<string>();

  params.tasks.filter((task) => !isMovableTask(task)).forEach((task) => {
    const normalizedStart = validDate(task.startDate) ? normalizeTaskStartDate(task.startDate, params.mode) : "";
    const duration = normalizeGanttDurationDays(task.durationDays);
    const finishDate = validDate(task.finishDate)
      ? task.finishDate
      : normalizedStart && duration > 0 ? calculateTaskFinishDate(normalizedStart, duration, params.mode) : "";
    scheduled.set(task.id, { ...task, startDate: normalizedStart, finishDate });
    if (!params.ignoreResourceCapacity && normalizedStart && finishDate) {
      calendar.addTask(task, normalizedStart, params.mode);
    }
  });

  const unscheduled = new Set(params.tasks.filter(isMovableTask).map((task) => task.id));
  while (unscheduled.size > 0) {
    const ready = [...unscheduled]
      .map((id) => byId.get(id)!)
      .filter((task) => {
        if (params.direction === "BACKWARD") {
          return (successorsByPredecessor.get(task.id) ?? [])
            .every(({ successorId }) => scheduled.has(successorId));
        }
        return task.predecessorDependencies
          .filter(isGanttFsDependency)
          .every((dependency) => !byId.has(dependency.predecessorTaskId) || scheduled.has(dependency.predecessorTaskId));
      })
      .sort((left, right) => {
        if (params.direction === "BACKWARD") {
          // Placement runs from the finish boundary backwards. Lower-ranked work
          // is placed first so lower-float / higher-impact work receives the
          // earlier completion slot after the backward pass is complete.
          return -rank(left, right)
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
      .filter(isGanttFsDependency)
      .map((dependency) => ({ dependency, predecessor: scheduled.get(dependency.predecessorTaskId) }))
      .filter((item): item is { dependency: ResourceScheduleDependency; predecessor: ScheduledTask } => Boolean(item.predecessor));
    const dependencyStarts = dependencies.map(({ dependency, predecessor }) => dependencyStartDate(predecessor, dependency, params.mode));
    const successorDependencies = (successorsByPredecessor.get(task.id) ?? [])
      .map(({ successorId, dependency }) => ({ dependency, successor: scheduled.get(successorId) }))
      .filter((item): item is { dependency: ResourceScheduleDependency; successor: ScheduledTask } => Boolean(item.successor?.startDate));
    const successorFinishCeilings = successorDependencies.map(({ dependency, successor }) => (
      dependencyFinishDate(successor, dependency, params.mode)
    ));
    // Rollup dates are derived output, never a scheduling input. Only explicit
    // locked boundaries, T0 and FS dependencies may anchor automatic work.
    const bounds = parentBoundsFor(task, byId);
    const baseStart = "";
    const notBefore = "";
    const hardFinishCeiling = task.projectId === params.currentProjectId ? params.hardFinishCeiling : "";
    const hardLatestFinish = dateMin([
      bounds.latestFinish,
      hardFinishCeiling,
      ...successorFinishCeilings,
    ]);
    const preferredLatestFinish = dateMin([
      hardLatestFinish,
      validDate(task.finishDate) && params.direction === "BACKWARD" ? task.finishDate : "",
    ]);
    const hardEarliestStart = dateMax([
      task.projectId === params.currentProjectId ? projectStartAnchor : "",
      bounds.earliestStart,
      ...dependencyStarts,
    ]);
    const shouldScheduleBackward = params.direction === "BACKWARD" && validDate(preferredLatestFinish);
    const requestedStartDate = dateMax([baseStart, notBefore, hardEarliestStart]);
    if (!requestedStartDate && !shouldScheduleBackward) {
      scheduled.set(task.id, { ...task, startDate: "", finishDate: "" });
      continue;
    }
    const latestFinishDate = hardLatestFinish;
    const placement = shouldScheduleBackward
      ? findResourceStartDateBackward({
        task,
        requestedFinishDate: preferredLatestFinish,
        earliestStartDate: hardEarliestStart,
        calendar,
        mode: params.mode,
      })
      : findResourceStartDate({ task, requestedStartDate, latestFinishDate, calendar, mode: params.mode });
    if (!placement.startDate) {
      const code = hardFinishCeiling ? "PROJECT_HARD_FINISH_VIOLATION"
        : placement.reason === "PARENT_BOUNDARY_VIOLATION" ? "PARENT_BOUNDARY_VIOLATION"
          : placement.reason === "MISSING_START_DATE" ? "MISSING_START_DATE"
            : "RESOURCE_CAPACITY_EXCEEDED";
      issues.push({
        id: `placement:${task.id}:${code}`,
        code,
        severity: code === "PROJECT_HARD_FINISH_VIOLATION" || (code === "PARENT_BOUNDARY_VIOLATION" && bounds.lockedTaskIds.length > 0) ? "ERROR" : "WARNING",
        taskIds: [task.id, ...bounds.lockedTaskIds],
        message: code === "PROJECT_HARD_FINISH_VIOLATION"
            ? `任务「${task.taskName || task.id}」无法在 WBS 完成锚点 ${hardFinishCeiling} 前满足依赖和资源约束。`
            : code === "PARENT_BOUNDARY_VIOLATION"
            ? `任务「${task.taskName || task.id}」无法在父任务锁定边界内满足依赖和资源约束。`
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
    if (!params.ignoreResourceCapacity && (
      (shouldScheduleBackward && placement.finishDate !== preferredLatestFinish)
      || (!shouldScheduleBackward && placement.startDate !== requestedStartDate)
    )) {
      resourceConstrainedTaskIds.add(task.id);
    }
    scheduled.set(task.id, placed);
    if (!params.ignoreResourceCapacity) {
      calendar.addTask(placed, placed.startDate, params.mode);
    }
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
    relativeStartOffsetDays: task.relativeStartOffsetDays ?? null,
    relativeFinishOffsetDays: task.relativeFinishOffsetDays ?? null,
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

export interface ResourceScheduleSnapshotContext {
  projectStartDate?: string;
  expectedEndDate?: string;
  hardFinishDate?: string;
  calendarMode?: GanttCalendarMode;
}

export const resourceScheduleSnapshotHash = (
  tasks: ResourceSchedulingTask[],
  context: ResourceScheduleSnapshotContext = {},
) => (
  createHash("sha256").update(JSON.stringify({
    tasks: snapshotPayload(tasks),
    context: {
      projectStartDate: context.projectStartDate ?? "",
      expectedEndDate: context.expectedEndDate ?? "",
      hardFinishDate: context.hardFinishDate ?? "",
      calendarMode: context.calendarMode ?? "",
    },
  })).digest("hex")
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
      relativeStartOffsetDays: change.relativeStartOffsetDays ?? null,
      relativeFinishOffsetDays: change.relativeFinishOffsetDays ?? null,
      ...(typeof change.durationDays === "number"
        ? {
          durationDays: change.durationDays,
          durationMinutes: change.durationMinutes ?? Math.round(change.durationDays * GANTT_HOURS_PER_DAY * 60),
          estimatedWorkHours: change.estimatedWorkHours ?? Math.round(change.durationDays * GANTT_HOURS_PER_DAY * 100) / 100,
        }
        : {}),
      ...(change.taskMode ? { taskMode: change.taskMode } : {}),
    } : task;
  });
};

const withSuggestedDurations = (
  tasks: ResourceSchedulingTask[],
  suggestions: GanttDurationSuggestion[],
) => {
  const suggestionByTaskId = new Map(suggestions.map((suggestion) => [suggestion.taskId, suggestion] as const));
  return tasks.map((task) => {
    const suggestion = suggestionByTaskId.get(task.id);
    if (!suggestion || normalizeGanttDurationDays(task.durationDays) > 0) return task;
    const durationDays = suggestion.suggestedDurationDays;
    return {
      ...task,
      durationDays,
      durationMinutes: Math.round(durationDays * GANTT_HOURS_PER_DAY * 60),
      estimatedWorkHours: Math.round(durationDays * GANTT_HOURS_PER_DAY * 100) / 100,
    };
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
}) => params.tasks.map((task) => {
  if (task.projectId !== params.currentProjectId || !task.isLeaf) return task;
  if (task.progress > 0 || normalizeGanttScheduleMode(task.taskMode) === "DATES_FIXED") return task;
  // Scheduling direction belongs to the current project-wide run. Older
  // per-task forward/backward flags are intentionally read as automatic so
  // they cannot leave stale anchors in a later formal calculation.
  return { ...task, taskMode: "AUTO" };
});

const scopedSchedulingPrerequisites = (params: {
  tasks: ResourceSchedulingTask[];
  currentProjectId: string;
  modeOverride: ResourceScheduleModeOverride;
  projectStartDate: string;
  hardFinishDate: string;
  relativeSchedule?: boolean;
}) => {
  const byId = new Map(params.tasks.map((task) => [task.id, task]));
  return params.tasks.flatMap((task): ResourceScheduleIssue[] => {
    if (task.projectId !== params.currentProjectId || !task.isLeaf) return [];
    if (task.progress > 0) return [];
    const becomesAutomatic = normalizeGanttScheduleMode(task.taskMode) !== "DATES_FIXED";
    if (!becomesAutomatic) return [];
    if (!task.isMilestone && normalizeGanttDurationDays(task.durationDays) <= 0) {
      return [{
        id: `missing-duration:${task.id}`,
        code: "MISSING_DURATION",
        severity: "ERROR",
        taskIds: [task.id],
        message: `任务「${task.taskName || task.id}」缺少已确认的正式工期，不能自动排期。`,
        suggestion: "先填写并确认正式工期；系统建议工期只能作为参考，不能直接替代正式工期。",
      }];
    }
    if (task.isMilestone || normalizeGanttDurationDays(task.durationDays) <= 0) return [];
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
    const bounds = parentBoundsFor(task, byId);
    const hasDependencyAnchor = task.predecessorDependencies.filter(isGanttFsDependency).some((dependency) => (
      Boolean(byId.get(dependency.predecessorTaskId))
    ));
    const hasSuccessorAnchor = params.modeOverride === "DURATION_BACKWARD" && params.tasks.some((candidate) => (
      candidate.predecessorDependencies.filter(isGanttFsDependency)
        .some((dependency) => dependency.predecessorTaskId === task.id && validDate(candidate.startDate))
    ));
    const isBackwardRun = params.modeOverride === "DURATION_BACKWARD";
    const hasAnchor = params.relativeSchedule
      ? true
      : isBackwardRun
      ? validDate(task.finishDate)
        || hasSuccessorAnchor
        || validDate(bounds.latestFinish)
        || validDate(params.hardFinishDate)
      : hasDependencyAnchor
        || validDate(bounds.earliestStart)
        || validDate(params.projectStartDate);
    if (!hasAnchor) {
      issues.push({
        id: `missing-anchor:${task.id}`,
        code: "MISSING_SCHEDULE_ANCHOR",
        severity: "ERROR",
        taskIds: [task.id],
        message: isBackwardRun
          ? `任务「${task.taskName || task.id}」缺少计划完成、后续任务或父级完成边界，无法确定倒排锚点。`
          : `任务「${task.taskName || task.id}」缺少项目 T0、紧前任务或父级硬边界，无法确定正式排期锚点。`,
        suggestion: isBackwardRun
          ? "补充计划完成、后续任务或父级计划完成边界后重新自动排期。"
          : "补充项目 T0、紧前任务或父级锁定边界后重新正式排期。",
      });
    }
    return issues;
  });
};

const withCpmMetrics = (
  tasks: ResourceSchedulingTask[],
  metricsByTaskId: Map<string, GanttCpmMetrics>,
) => tasks.map((task) => {
  const metrics = metricsByTaskId.get(task.id);
  if (!metrics) return task;
  return {
    ...task,
    earlyStartDate: metrics.earlyStartDate,
    lateStartDate: metrics.lateStartDate,
    lateFinishDate: metrics.lateFinishDate,
    totalFloatMinutes: metrics.totalFloatMinutes,
  };
});

const mergeScheduledDatesIntoOriginal = (
  original: ResourceSchedulingTask[],
  scheduled: ResourceSchedulingTask[],
  projectId: string,
) => {
  const scheduledById = new Map(scheduled.map((task) => [task.id, task] as const));
  return original
    .filter((task) => task.projectId === projectId)
    .map((task) => {
      const calculated = scheduledById.get(task.id);
      return calculated ? {
        ...task,
        startDate: calculated.startDate,
        finishDate: calculated.finishDate,
      } : task;
    });
};

/**
 * Derive resource-caused serial links from the final leveled result. These
 * links are explanatory only: they never alter the user's FS dependency
 * graph, but make the capacity-constrained critical chain inspectable.
 */
const deriveResourceCriticalChain = (params: {
  tasks: ResourceSchedulingTask[];
  currentProjectId: string;
  resourceConstrainedTaskIds: Iterable<string>;
  calendarMode: GanttCalendarMode;
}) => {
  const constrainedTaskIds = new Set(params.resourceConstrainedTaskIds);
  const currentProjectTasks = params.tasks.filter((task) => (
    task.projectId === params.currentProjectId
    && task.isLeaf
    && validDateRange(task)
  ));
  const linksByKey = new Map<string, ResourceCriticalChainLink>();

  currentProjectTasks
    .filter((task) => constrainedTaskIds.has(task.id))
    .forEach((successor) => {
      const fsPredecessorIds = new Set(
        successor.predecessorDependencies
          .filter(isGanttFsDependency)
          .map((dependency) => dependency.predecessorTaskId),
      );
      normalizedAssignments(successor).forEach((assignment) => {
        const predecessor = currentProjectTasks
          .filter((candidate) => (
            candidate.id !== successor.id
            && !fsPredecessorIds.has(candidate.id)
            && nextTaskStartDate(candidate.finishDate, params.calendarMode) === successor.startDate
            && normalizedAssignments(candidate).some((candidateAssignment) => (
              candidateAssignment.ownerKey === assignment.ownerKey
            ))
          ))
          .sort((left, right) => (
            right.finishDate.localeCompare(left.finishDate)
            || right.sortOrder - left.sortOrder
            || right.id.localeCompare(left.id)
          ))[0];
        if (!predecessor) return;
        const link: ResourceCriticalChainLink = {
          predecessorTaskId: predecessor.id,
          successorTaskId: successor.id,
          ownerKey: assignment.ownerKey,
        };
        linksByKey.set(`${link.predecessorTaskId}:${link.successorTaskId}:${link.ownerKey}`, link);
      });
    });

  const links = [...linksByKey.values()].sort((left, right) => (
    left.predecessorTaskId.localeCompare(right.predecessorTaskId)
    || left.successorTaskId.localeCompare(right.successorTaskId)
    || left.ownerKey.localeCompare(right.ownerKey)
  ));
  return {
    taskIds: [...new Set(links.flatMap((link) => [link.predecessorTaskId, link.successorTaskId]))]
      .sort((left, right) => left.localeCompare(right)),
    links,
  };
};

const candidateTaskExplanations = (params: {
  tasks: ResourceSchedulingTask[];
  currentProjectId: string;
  initialMetrics: Map<string, GanttCpmMetrics>;
  finalMetrics: Map<string, GanttCpmMetrics>;
  resourceConstrainedTaskIds: Set<string>;
  resourceCriticalChainTaskIds: Set<string>;
  direction: ResourceScheduleDirection;
  relativeSchedule: boolean;
}) => {
  const byId = new Map(params.tasks.map((task) => [task.id, task] as const));
  const weights = criticalWeights(params.tasks);
  return params.tasks
    .filter((task) => (
      task.projectId === params.currentProjectId
      && task.isLeaf
    ))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
    .map((task): ResourceScheduleTaskExplanation => {
      const initial = params.initialMetrics.get(task.id);
      const final = params.finalMetrics.get(task.id);
      const bounds = parentBoundsFor(task, byId);
      const reasonCodes: ResourceScheduleReasonCode[] = [];
      const details: string[] = [];
      if (task.predecessorDependencies.some(isGanttFsDependency)) {
        reasonCodes.push("DEPENDENCY");
        details.push(params.relativeSchedule
          ? "计划开始不早于全部 FS 紧前任务完成后的下一个 T0 工作日序号。"
          : "计划开始不早于全部 FS 紧前任务完成后的首个可用日期。");
      }
      if (params.resourceConstrainedTaskIds.has(task.id)) {
        reasonCodes.push("RESOURCE_CAPACITY");
        details.push(params.relativeSchedule
          ? "负责人在同一相对工作日窗口容量不足，任务被移动到下一段可用 T0 工作日。"
          : "负责人同一时段容量不足，任务被移动到下一段可用日历窗口。");
      }
      if (params.resourceCriticalChainTaskIds.has(task.id)) {
        reasonCodes.push("RESOURCE_CRITICAL_CHAIN");
        details.push("任务位于负责人容量导致的资源关键链，蓝色连线仅说明资源串行，不会改写 FS 紧前关系。");
      }
      if (bounds.earliestStart || bounds.latestFinish) {
        reasonCodes.push("HARD_BOUNDARY");
        details.push("排期受父任务锁定边界约束，不允许越界。");
      }
      if (initial?.totalFloatMinutes != null) {
        reasonCodes.push("INITIAL_FLOAT");
        details.push(`依赖网络初算总浮动为 ${ganttFloatDays(initial.totalFloatMinutes)} 天，浮动越小越优先占用资源。`);
      }
      if ((weights.get(task.id) ?? 0) > normalizeGanttDurationDays(task.durationDays)) {
        reasonCodes.push("DOWNSTREAM_IMPACT");
        details.push("该任务会解锁较长的下游链路，因此在同等条件下优先安排。");
      }
      if (Number(task.schedulePriority ?? 500) !== 500) {
        reasonCodes.push("BUSINESS_PRIORITY");
        details.push(`业务优先级权重为 ${Number(task.schedulePriority ?? 500)}。`);
      }
      if (params.direction === "BACKWARD") {
        reasonCodes.push("BACKWARD_PLACEMENT");
        details.push("本次从完成边界向前寻找可行日期，但高优先级任务仍优先完成。");
      }
      if (final?.isCritical) {
        reasonCodes.push("CRITICAL_PATH");
        details.push("资源平衡后总浮动不大于 0，任务位于最终关键路径。");
      }
      if (reasonCodes.length === 0) {
        reasonCodes.push("PRESERVED_DATE");
        details.push("现有日期已满足依赖、资源与边界约束，因此保持不变。");
      }
      const taskLabel = task.taskName || task.id;
      const relativeStartOffsetDays = params.relativeSchedule && validDate(task.startDate)
        ? ganttOffsetFromAbstractDate(task.startDate)
        : null;
      const relativeFinishOffsetDays = params.relativeSchedule && validDate(task.finishDate)
        ? ganttOffsetFromAbstractDate(task.finishDate)
        : null;
      const dateLabel = params.relativeSchedule
        ? `${formatGanttRelativeOffset(relativeStartOffsetDays)} - ${formatGanttRelativeOffset(relativeFinishOffsetDays)}`
        : `${task.startDate || "未排期"} - ${task.finishDate || "未排期"}`;
      const summary = params.resourceConstrainedTaskIds.has(task.id)
        ? `「${taskLabel}」因负责人容量冲突调整至 ${dateLabel}。`
        : params.resourceCriticalChainTaskIds.has(task.id)
          ? `「${taskLabel}」位于负责人容量形成的资源关键链。`
        : final?.isCritical
          ? `「${taskLabel}」位于资源平衡后的关键路径。`
          : `「${taskLabel}」已按依赖、浮动、优先级与父级边界完成计算。`;
      return {
        taskId: task.id,
        startDate: params.relativeSchedule ? "" : task.startDate,
        finishDate: params.relativeSchedule ? "" : task.finishDate,
        relativeStartOffsetDays,
        relativeFinishOffsetDays,
        initialTotalFloatDays: ganttFloatDays(initial?.totalFloatMinutes),
        finalTotalFloatDays: ganttFloatDays(final?.totalFloatMinutes),
        isCritical: Boolean(final?.isCritical),
        resourceConstrained: params.resourceConstrainedTaskIds.has(task.id),
        resourceCritical: params.resourceCriticalChainTaskIds.has(task.id),
        reasonCodes,
        summary,
        details,
      };
    });
};

export const createResourceScheduleCandidates = (params: {
  tasks: ResourceSchedulingTask[];
  currentProjectId: string;
  calendarMode: GanttCalendarMode;
  /** Project T0. It anchors forward scheduling for root execution work. */
  projectStartDate?: string;
  /** Soft project target, used to show completion delay. */
  expectedEndDate: string;
  /** WBS completion anchor for backward scheduling. Candidate dates cannot exceed this date. */
  hardFinishDate?: string;
  /** Scope controls preview and duration suggestions, not task-level modes. */
  scopeTaskIds?: Iterable<string>;
  /** Scheduling direction for this project-wide run. */
  modeOverride?: ResourceScheduleModeOverride;
}): ResourceScheduleCandidateResult => {
  const projectStartDate = validDate(params.projectStartDate) ? params.projectStartDate! : "";
  const hardFinishCeiling = validDate(params.hardFinishDate) ? params.hardFinishDate! : "";
  const modeOverride = normalizeModeOverride(params.modeOverride);
  const requiresWbsFinishDate = modeOverride === "DURATION_BACKWARD";
  // Forward scheduling does not require a concrete calendar date. Until the
  // project T0 is known, the same formal algorithm runs against an abstract
  // working-day calendar and persists only T0-relative offsets.
  const relativeSchedule = !projectStartDate && !requiresWbsFinishDate;
  const effectiveCalendarMode: GanttCalendarMode = relativeSchedule ? "CALENDAR_DAYS" : params.calendarMode;
  const effectiveProjectStartDate = relativeSchedule ? GANTT_RELATIVE_T0_ANCHOR : projectStartDate;
  // The legacy hard-finish column now stores only the WBS anchor used by a
  // backward run. It must not become an implicit deadline for forward or
  // unchanged scheduling modes.
  const effectiveHardFinishCeiling = requiresWbsFinishDate ? hardFinishCeiling : "";
  const effectiveExpectedEndDate = relativeSchedule ? "" : params.expectedEndDate;
  const effectiveDirection: ResourceScheduleDirection = relativeSchedule
    ? "FORWARD"
    : scheduleDirectionFor(modeOverride);
  const snapshotHash = resourceScheduleSnapshotHash(params.tasks, {
    projectStartDate,
    expectedEndDate: params.expectedEndDate,
    hardFinishDate: hardFinishCeiling,
    calendarMode: params.calendarMode,
  });
  const currentProjectTasks = params.tasks.filter((task) => task.projectId === params.currentProjectId);
  const currentProjectLeafTaskIds = new Set(
    currentProjectTasks.filter((task) => task.isLeaf).map((task) => task.id),
  );
  const durationSuggestionResult = createGanttDurationSuggestions(currentProjectTasks, params.calendarMode);
  const originalById = new Map(params.tasks.map((task) => [task.id, task] as const));
  const currentProjectTaskIds = new Set(currentProjectTasks.map((task) => task.id));
  const requestedScope = new Set(params.scopeTaskIds ?? currentProjectLeafTaskIds);
  const scopeTaskIds = new Set(
    [...requestedScope].filter((taskId) => currentProjectLeafTaskIds.has(taskId)),
  );
  const scopedDurationSuggestions = durationSuggestionResult.suggestions
    .filter((suggestion) => scopeTaskIds.has(suggestion.taskId));
  const scopedDurationSuggestionIssues = durationSuggestionResult.issues
    .filter((issue) => issue.taskIds.some((taskId) => scopeTaskIds.has(taskId)));
  const suggestedDurationTaskIds = new Set(scopedDurationSuggestions.map((suggestion) => suggestion.taskId));
  const modeAnchorIssues: ResourceScheduleIssue[] = [
    ...(requiresWbsFinishDate && !hardFinishCeiling ? [{
      id: "backward-schedule-missing-wbs-finish",
      code: "MISSING_SCHEDULE_ANCHOR" as const,
      severity: "ERROR" as const,
      taskIds: [...scopeTaskIds],
      message: "工期固定 · 倒排需要先填写 WBS 结束日期。",
      suggestion: "在顶部排期设置中填写 WBS 结束日期后重新计算。",
    }] : []),
  ];

  // Without a concrete project T0, the date scheduler is deliberately run in
  // an isolated abstract calendar. Every day index is a working day and the
  // internal 2000-01-03 anchor is never returned or persisted.
  const scheduleSourceTasks = relativeSchedule
    ? params.tasks
      .filter((task) => task.projectId === params.currentProjectId)
      .map((task) => ({
        ...task,
        startDate: isGanttRelativeOffset(task.relativeStartOffsetDays)
          ? abstractDateFromGanttOffset(task.relativeStartOffsetDays)
          : "",
        finishDate: isGanttRelativeOffset(task.relativeFinishOffsetDays)
          ? abstractDateFromGanttOffset(task.relativeFinishOffsetDays)
          : "",
      }))
    : params.tasks;
  // Suggested durations are an input to this *preview only*. Applying the
  // candidate makes them formal in the same transaction as the calculated
  // dates, preventing the previous two-step "suggest then re-run" dead end.
  const proposedScheduleSourceTasks = withSuggestedDurations(
    scheduleSourceTasks,
    scopedDurationSuggestions,
  );

  // One formal algorithm, two deterministic stages: first obtain CPM float
  // from T0 + FS + calendar + hard boundaries without resource capacity, then
  // allocate people using that CPM result. Normal data refreshes never call
  // this writer and therefore cannot reschedule leaf task dates.
  const expandedNetworkTasks = buildGanttLeafScheduleNetwork(proposedScheduleSourceTasks).tasks;
  const preliminarySchedulingTasks = scopedSchedulingTasks({
    tasks: expandedNetworkTasks,
    currentProjectId: params.currentProjectId,
  });
  const prerequisites = scopedSchedulingPrerequisites({
    tasks: expandedNetworkTasks,
    currentProjectId: params.currentProjectId,
    modeOverride,
    projectStartDate: effectiveProjectStartDate,
    hardFinishDate: effectiveHardFinishCeiling,
    relativeSchedule,
  });
  const preliminaryResult = scheduleWithPriority({
    tasks: preliminarySchedulingTasks,
    mode: effectiveCalendarMode,
    currentProjectId: params.currentProjectId,
    projectStartDate: effectiveProjectStartDate,
    hardFinishCeiling: effectiveHardFinishCeiling,
    direction: effectiveDirection,
    ignoreResourceCapacity: true,
  });
  const initialProjectTasks = mergeScheduledDatesIntoOriginal(
    proposedScheduleSourceTasks,
    preliminaryResult.tasks,
    params.currentProjectId,
  );
  const initialCpm = calculateGanttCpm(
    initialProjectTasks,
    effectiveCalendarMode,
    effectiveHardFinishCeiling || effectiveExpectedEndDate,
  );
  const networkTasks = withCpmMetrics(expandedNetworkTasks, initialCpm.metricsByTaskId);
  const schedulingTasks = scopedSchedulingTasks({
    tasks: networkTasks,
    currentProjectId: params.currentProjectId,
  });
  const relevantConflicts = (tasks: ResourceSchedulingTask[]) => detectResourceConflicts(tasks, effectiveCalendarMode)
    .filter((conflict) => conflict.taskIds.some((taskId) => currentProjectTaskIds.has(taskId)));
  const conflicts = relevantConflicts(proposedScheduleSourceTasks);
  const allCurrentIssues = detectResourceScheduleIssues(proposedScheduleSourceTasks, effectiveCalendarMode);
  const isSchedulableMissingStartIssue = (issue: ResourceScheduleIssue) => (
    issue.code === "MISSING_START_DATE"
    && issue.taskIds.every((taskId) => {
      const task = originalById.get(taskId);
      return Boolean(task && !isLockedTask(task));
    })
  );
  const currentIssues = [
    ...allCurrentIssues
      .filter((issue) => !isSchedulableMissingStartIssue(issue))
      .filter((issue) => issue.taskIds.some((taskId) => currentProjectTaskIds.has(taskId))),
    ...prerequisites,
    ...modeAnchorIssues,
  ];
  const scheduledResult = scheduleWithPriority({
    tasks: schedulingTasks,
    mode: effectiveCalendarMode,
    currentProjectId: params.currentProjectId,
    projectStartDate: effectiveProjectStartDate,
    hardFinishCeiling: effectiveHardFinishCeiling,
    direction: effectiveDirection,
  });
  const calculatedChanges = scheduledResult.tasks
    .filter((task) => {
      const original = originalById.get(task.id);
      if (!task.isCurrentProject || !task.isLeaf || !original) return false;
      const scheduleChanged = relativeSchedule
        ? !validDate(task.startDate)
          || !validDate(task.finishDate)
          || ganttOffsetFromAbstractDate(task.startDate) !== original.relativeStartOffsetDays
          || ganttOffsetFromAbstractDate(task.finishDate) !== original.relativeFinishOffsetDays
        : task.startDate !== original.startDate || task.finishDate !== original.finishDate;
      const durationChanged = suggestedDurationTaskIds.has(task.id)
        && Math.abs(normalizeGanttDurationDays(task.durationDays) - normalizeGanttDurationDays(original.durationDays)) > EPSILON;
      return scheduleChanged || durationChanged;
    })
    .map((task) => {
      return {
        taskId: task.id,
        startDate: relativeSchedule ? "" : task.startDate,
        finishDate: relativeSchedule ? "" : task.finishDate,
        ...(relativeSchedule
          ? {
            relativeStartOffsetDays: validDate(task.startDate)
              ? ganttOffsetFromAbstractDate(task.startDate)
              : null,
            relativeFinishOffsetDays: validDate(task.finishDate)
              ? ganttOffsetFromAbstractDate(task.finishDate)
              : null,
          }
          : {}),
        ...(suggestedDurationTaskIds.has(task.id)
          ? {
            durationDays: task.durationDays,
            durationMinutes: task.durationMinutes ?? Math.round(task.durationDays * GANTT_HOURS_PER_DAY * 60),
            estimatedWorkHours: task.estimatedWorkHours ?? Math.round(task.durationDays * GANTT_HOURS_PER_DAY * 100) / 100,
          }
          : {}),
      };
    });
  const finalProjectTasks = mergeScheduledDatesIntoOriginal(
    proposedScheduleSourceTasks,
    scheduledResult.tasks,
    params.currentProjectId,
  );
  const finalCpm = calculateGanttCpm(
    finalProjectTasks,
    effectiveCalendarMode,
    effectiveHardFinishCeiling || effectiveExpectedEndDate,
  );
  const resourceConstrainedTaskIds = new Set(scheduledResult.resourceConstrainedTaskIds);
  const resourceCriticalChain = deriveResourceCriticalChain({
    tasks: scheduledResult.tasks,
    currentProjectId: params.currentProjectId,
    resourceConstrainedTaskIds,
    calendarMode: effectiveCalendarMode,
  });
  const resourceCriticalChainTaskIds = new Set(resourceCriticalChain.taskIds);
  const taskExplanations = candidateTaskExplanations({
    tasks: scheduledResult.tasks,
    currentProjectId: params.currentProjectId,
    initialMetrics: initialCpm.metricsByTaskId,
    finalMetrics: finalCpm.metricsByTaskId,
    resourceConstrainedTaskIds,
    resourceCriticalChainTaskIds,
    direction: effectiveDirection,
    relativeSchedule,
  });
  const criticalTaskIds = taskExplanations
    .filter((item) => item.isCritical)
    .map((item) => item.taskId);
  const remainingConflicts = relevantConflicts(scheduledResult.tasks);
  const calculatedMetrics = metricsFor(
    proposedScheduleSourceTasks,
    scheduledResult.tasks,
    effectiveExpectedEndDate,
    conflicts,
    effectiveCalendarMode,
  );
  const relativeCompletionOffsetDays = relativeSchedule
    ? scheduledResult.tasks
      .filter((task) => task.projectId === params.currentProjectId && task.isLeaf && validDate(task.finishDate))
      .map((task) => ganttOffsetFromAbstractDate(task.finishDate))
      .sort((left, right) => right - left)[0] ?? null
    : null;
  const metrics: ResourceScheduleMetrics = {
    ...calculatedMetrics,
    completionDate: relativeSchedule ? "" : calculatedMetrics.completionDate,
    relativeCompletionOffsetDays,
    delayedDays: relativeSchedule ? 0 : calculatedMetrics.delayedDays,
  };
  const remainingIssues = [
    ...preliminaryResult.issues
      .filter((issue) => !isSchedulableMissingStartIssue(issue))
      .filter((issue) => issue.taskIds.some((taskId) => currentProjectTaskIds.has(taskId))),
    ...scheduledResult.issues
      .filter((issue) => !isSchedulableMissingStartIssue(issue))
      .filter((issue) => issue.taskIds.some((taskId) => currentProjectTaskIds.has(taskId))),
    ...prerequisites,
    ...modeAnchorIssues,
  ];
  const deduplicatedRemainingIssues = [...new Map(remainingIssues.map((issue) => [issue.id, issue])).values()];
  const hasBlockingIssue = deduplicatedRemainingIssues.some((issue) => issue.severity === "ERROR");
  const candidate: ResourceScheduleCandidate = {
    id: `${snapshotHash}:${FORMAL_RESOURCE_SCHEDULE_CANDIDATE_KIND}`,
    kind: FORMAL_RESOURCE_SCHEDULE_CANDIDATE_KIND,
    title: relativeSchedule ? "正式自动排期（T0 相对计划）" : "正式自动排期",
    explanation: relativeSchedule
      ? "项目尚未填写具体 T0。系统以 T0 为第 0 个工作日，按 FS 紧前关系、负责人容量、下游影响和优先级计算相对工期；符合父级窗口和唯一负责人条件的未定工期子任务，会先得到系统建议，并在确认方案时与排期结果一并写入正式工期。FS 关系用于决定顺序，不会单独阻止建议生成。填写具体 T0 后才会按项目日历与法定节假日换算为真实日期。"
      : "先按项目 T0、FS 紧前关系、日历和锁定边界计算网络浮动，再按负责人容量、下游影响和优先级安排未开始的叶子任务。对符合父级窗口和唯一负责人条件的未定工期子任务，系统在预览中使用建议工期，确认方案时才会与日期一并写入正式计划；FS 关系用于决定先后顺序。",
    relativeSchedule,
    applicable: calculatedChanges.length > 0 && !hasBlockingIssue,
    snapshotHash,
    // A blocking prerequisite must never leak a partial or fabricated plan to
    // the write endpoint. The issues remain visible for the user to repair.
    changes: hasBlockingIssue ? [] : calculatedChanges,
    remainingConflicts,
    issues: deduplicatedRemainingIssues,
    resourceConstrainedTaskIds: scheduledResult.resourceConstrainedTaskIds,
    resourceCriticalChainTaskIds: resourceCriticalChain.taskIds,
    resourceCriticalChainLinks: resourceCriticalChain.links,
    criticalTaskIds,
    taskExplanations,
    metrics,
  };
  return {
    snapshotHash,
    conflicts,
    issues: currentIssues,
    durationSuggestions: scopedDurationSuggestions,
    durationSuggestionIssues: scopedDurationSuggestionIssues,
    candidates: [candidate],
  };
};
