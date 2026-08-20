import {
  GANTT_HOURS_PER_DAY,
  normalizeTaskFinishDate,
  normalizeTaskStartDate,
  shiftTaskDate,
  type GanttCalendarMode,
} from "@/lib/gantt-calendar";
import {
  isGanttFsDependency,
  normalizeGanttScheduleMode,
} from "@/lib/gantt-planning-rules";
import { buildGanttLeafScheduleNetwork } from "@/lib/gantt-schedule-network";

export const GANTT_MINUTES_PER_DAY = GANTT_HOURS_PER_DAY * 60;
export const GANTT_NEAR_CRITICAL_MINUTES = GANTT_MINUTES_PER_DAY * 2;

export type GanttScheduleStatus =
  | "UNSCHEDULED"
  | "INVALID_DEPENDENCY"
  | "NEGATIVE_FLOAT"
  | "CRITICAL"
  | "NEAR_CRITICAL"
  | "NORMAL";

export interface CpmGanttDependency {
  predecessorTaskId: string;
  type?: number;
  lag?: number;
  lagFormat?: number;
}

export interface CpmGanttTask {
  id: string;
  parentId?: string | null;
  parentBoundaryMode?: string;
  /** Direct project-member assignments. Summary rows only participate in
   * critical-path display when exactly one person owns that summary. */
  ownerMemberIds?: string[];
  startDate: string;
  finishDate?: string;
  durationDays: number;
  durationMinutes?: number;
  taskMode?: string;
  isMilestone?: boolean;
  constraintType?: number | null;
  constraintDate?: string;
  predecessorDependencies?: CpmGanttDependency[];
  progress?: number;
  actualStartDate?: string;
  actualEndDate?: string;
}

export interface GanttCpmMetrics {
  earlyStartDate: string;
  earlyFinishDate: string;
  lateStartDate: string;
  lateFinishDate: string;
  totalFloatMinutes: number | null;
  freeFloatMinutes: number | null;
  scheduleStatus: GanttScheduleStatus;
  isCritical: boolean;
}

export interface GanttCpmResult {
  projectStartDate: string;
  calculatedFinishDate: string;
  requiredFinishVarianceMinutes: number | null;
  hasDependencyCycle: boolean;
  /**
   * Executable terminal tasks that belong to one of the project's longest
   * finish-to-start paths. This is deliberately independent from local float
   * constraints such as a locked summary boundary.
   */
  projectCriticalTaskIds: Set<string>;
  metricsByTaskId: Map<string, GanttCpmMetrics>;
}

type CpmEdge = {
  predecessorTaskId: string;
  successorTaskId: string;
  weightMinutes: number;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isCompletedWithActualFinish = (task: CpmGanttTask) => (
  Number(task.progress ?? 0) >= 100 && DATE_PATTERN.test(task.actualEndDate ?? "")
);

const effectiveTaskStartDate = (task: CpmGanttTask) => {
  if (isCompletedWithActualFinish(task) && DATE_PATTERN.test(task.actualStartDate ?? "")) {
    return task.actualStartDate!;
  }
  return task.startDate;
};

const plannedStartConstrainsCpm = (task: CpmGanttTask) => {
  if (isCompletedWithActualFinish(task)) return true;
  const rawMode = String(task.taskMode ?? "").trim();
  // Preserve legacy callers that predate task modes. Explicit AUTO tasks are
  // movable: their resource-levelled placement must not become a business
  // constraint and feed back into the red FS critical path.
  if (!rawMode) return true;
  return normalizeGanttScheduleMode(rawMode) !== "AUTO";
};

const taskDurationMinutes = (task: CpmGanttTask, mode: GanttCalendarMode) => {
  if (task.isMilestone) return 0;
  if (isCompletedWithActualFinish(task)) {
    const actualStartDate = effectiveTaskStartDate(task);
    const actualEndDate = task.actualEndDate!;
    if (DATE_PATTERN.test(actualStartDate) && actualEndDate >= actualStartDate) {
      // A completed task consumes its actual elapsed working/calendar window
      // in CPM. This captures a late completion without ever reserving future
      // resources for a task that is already done.
      return (scheduleDayDistance(actualStartDate, actualEndDate, mode) + 1) * GANTT_MINUTES_PER_DAY;
    }
  }
  const explicit = Number(task.durationMinutes);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  const days = Number(task.durationDays);
  return Number.isFinite(days) && days > 0 ? Math.round(days * GANTT_MINUTES_PER_DAY) : 0;
};

export const ganttDependencyLagMinutes = (
  dependency: Pick<CpmGanttDependency, "lag" | "lagFormat">,
) => {
  const lag = Number(dependency.lag ?? 0);
  if (!Number.isFinite(lag)) return 0;
  // Project XML LinkLag and the persisted dependency value use tenths of a minute.
  return Math.round(lag / 10);
};

const scheduleDayDistance = (
  fromDate: string,
  toDate: string,
  mode: GanttCalendarMode,
) => {
  if (fromDate === toDate) return 0;
  const direction: 1 | -1 = toDate > fromDate ? 1 : -1;
  let cursor = fromDate;
  let days = 0;
  let guard = 0;
  while ((direction > 0 ? cursor < toDate : cursor > toDate) && guard < 100_000) {
    cursor = shiftTaskDate(cursor, direction, mode);
    days += direction;
    guard += 1;
  }
  return days;
};

const dateToMinutes = (
  origin: string,
  value: string,
  mode: GanttCalendarMode,
  kind: "START" | "FINISH" = "START",
) => {
  const normalized = kind === "FINISH"
    ? normalizeTaskFinishDate(value, mode)
    : normalizeTaskStartDate(value, mode);
  return scheduleDayDistance(origin, normalized, mode) * GANTT_MINUTES_PER_DAY;
};

const dateFromMinutes = (
  origin: string,
  minutes: number,
  mode: GanttCalendarMode,
) => shiftTaskDate(origin, Math.floor(minutes / GANTT_MINUTES_PER_DAY), mode);

const finishDateFromMinutes = (
  origin: string,
  finishMinutes: number,
  startMinutes: number,
  mode: GanttCalendarMode,
) => {
  if (finishMinutes === startMinutes) return dateFromMinutes(origin, startMinutes, mode);
  const occupiedMinute = finishMinutes - 1;
  return dateFromMinutes(origin, occupiedMinute, mode);
};

const dependencyWeight = (
  predecessorDuration: number,
  dependency: CpmGanttDependency,
) => {
  const lag = ganttDependencyLagMinutes(dependency);
  return predecessorDuration + lag;
};

const emptyMetrics = (status: GanttScheduleStatus = "UNSCHEDULED"): GanttCpmMetrics => ({
  earlyStartDate: "",
  earlyFinishDate: "",
  lateStartDate: "",
  lateFinishDate: "",
  totalFloatMinutes: null,
  freeFloatMinutes: null,
  scheduleStatus: status,
  isCritical: false,
});

const statusForFloat = (totalFloatMinutes: number): GanttScheduleStatus => {
  if (totalFloatMinutes < 0) return "NEGATIVE_FLOAT";
  if (totalFloatMinutes <= GANTT_NEAR_CRITICAL_MINUTES) return "NEAR_CRITICAL";
  return "NORMAL";
};

const constraintBounds = (
  task: CpmGanttTask,
  durationMinutes: number,
  origin: string,
  mode: GanttCalendarMode,
) => {
  if (!task.constraintDate || !DATE_PATTERN.test(task.constraintDate) || task.constraintType == null) {
    return { lower: Number.NEGATIVE_INFINITY, upper: Number.POSITIVE_INFINITY };
  }
  const type = task.constraintType;
  const startBound = dateToMinutes(origin, task.constraintDate, mode, "START");
  const finishBound = dateToMinutes(origin, task.constraintDate, mode, "FINISH") + GANTT_MINUTES_PER_DAY;
  if (type === 2) return { lower: startBound, upper: startBound }; // Must Start On
  if (type === 3) return { lower: finishBound - durationMinutes, upper: finishBound - durationMinutes }; // Must Finish On
  if (type === 4) return { lower: startBound, upper: Number.POSITIVE_INFINITY }; // Start No Earlier Than
  if (type === 5) return { lower: Number.NEGATIVE_INFINITY, upper: startBound }; // Start No Later Than
  if (type === 6) return { lower: finishBound - durationMinutes, upper: Number.POSITIVE_INFINITY }; // Finish No Earlier Than
  if (type === 7) return { lower: Number.NEGATIVE_INFINITY, upper: finishBound - durationMinutes }; // Finish No Later Than
  return { lower: Number.NEGATIVE_INFINITY, upper: Number.POSITIVE_INFINITY };
};

export const calculateGanttCpm = (
  tasks: CpmGanttTask[],
  mode: GanttCalendarMode,
  requiredFinishDate = "",
): GanttCpmResult => {
  const metricsByTaskId = new Map<string, GanttCpmMetrics>();
  if (tasks.length === 0) {
    tasks.forEach((task) => metricsByTaskId.set(task.id, emptyMetrics()));
    return {
      projectStartDate: "",
      calculatedFinishDate: "",
      requiredFinishVarianceMinutes: null,
      hasDependencyCycle: false,
      projectCriticalTaskIds: new Set(),
      metricsByTaskId,
    };
  }

  const childrenByParentId = new Map<string, string[]>();
  tasks.forEach((task) => {
    if (!task.parentId) return;
    childrenByParentId.set(task.parentId, [...(childrenByParentId.get(task.parentId) ?? []), task.id]);
  });
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const expandedNetwork = buildGanttLeafScheduleNetwork(tasks);
  const leafTaskIdSet = new Set(expandedNetwork.leafTaskIds);
  const networkTasks = expandedNetwork.tasks.filter((task) => leafTaskIdSet.has(task.id));
  // The project origin belongs to the executable network. Summary dates are
  // rolled-up display values and must not move the CPM clock ahead of the
  // earliest leaf activity. Keep a fallback for undated leaf-only test data
  // and legacy plans where only a summary row carries a date.
  const networkValidDates = networkTasks
    .map((task) => effectiveTaskStartDate(task))
    .filter((value) => DATE_PATTERN.test(value));
  const fallbackValidDates = tasks
    .map((task) => effectiveTaskStartDate(task))
    .filter((value) => DATE_PATTERN.test(value));
  const projectStartDate = (networkValidDates.length > 0 ? networkValidDates : fallbackValidDates).sort()[0] ?? "";
  if (!projectStartDate) {
    tasks.forEach((task) => metricsByTaskId.set(task.id, emptyMetrics()));
    return {
      projectStartDate,
      calculatedFinishDate: "",
      requiredFinishVarianceMinutes: null,
      hasDependencyCycle: false,
      projectCriticalTaskIds: new Set(),
      metricsByTaskId,
    };
  }
  const networkTaskById = new Map(networkTasks.map((task) => [task.id, task]));
  const durationById = new Map(networkTasks.map((task) => [task.id, taskDurationMinutes(task, mode)]));
  const schedulableIds = new Set(networkTasks
    .filter((task) => task.isMilestone || taskDurationMinutes(task, mode) > 0)
    .map((task) => task.id));
  const incoming = new Map<string, CpmEdge[]>();
  const outgoing = new Map<string, CpmEdge[]>();
  const invalidDependencyIds = new Set<string>();

  for (const successor of networkTasks) {
    for (const dependency of successor.predecessorDependencies ?? []) {
      if (!schedulableIds.has(successor.id)) continue;
      if (!isGanttFsDependency(dependency)) {
        invalidDependencyIds.add(successor.id);
        continue;
      }
      if (!schedulableIds.has(dependency.predecessorTaskId)) {
        if (taskById.has(dependency.predecessorTaskId)) invalidDependencyIds.add(successor.id);
        continue;
      }
      const edge: CpmEdge = {
        predecessorTaskId: dependency.predecessorTaskId,
        successorTaskId: successor.id,
        weightMinutes: dependencyWeight(
          durationById.get(dependency.predecessorTaskId) ?? 0,
          dependency,
        ),
      };
      incoming.set(successor.id, [...(incoming.get(successor.id) ?? []), edge]);
      outgoing.set(edge.predecessorTaskId, [...(outgoing.get(edge.predecessorTaskId) ?? []), edge]);
    }
  }

  const inDegree = new Map([...schedulableIds].map((id) => [id, 0]));
  incoming.forEach((edges, id) => inDegree.set(id, edges.length));
  const queue = [...schedulableIds].filter((id) => (inDegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const edge of outgoing.get(id) ?? []) {
      const degree = (inDegree.get(edge.successorTaskId) ?? 0) - 1;
      inDegree.set(edge.successorTaskId, degree);
      if (degree === 0) queue.push(edge.successorTaskId);
    }
  }
  const cycleIds = new Set([...schedulableIds].filter((id) => !order.includes(id)));

  const earlyStart = new Map<string, number>();
  const earlyFinish = new Map<string, number>();
  for (const id of order) {
    const task = networkTaskById.get(id)!;
    const duration = durationById.get(id) ?? 0;
    const effectiveStartDate = effectiveTaskStartDate(task);
    const baseStart = plannedStartConstrainsCpm(task) && DATE_PATTERN.test(effectiveStartDate)
      ? dateToMinutes(projectStartDate, effectiveStartDate, mode, "START")
      : 0;
    const dependencyStart = Math.max(
      Number.NEGATIVE_INFINITY,
      ...(incoming.get(id) ?? []).map((edge) => (earlyStart.get(edge.predecessorTaskId) ?? 0) + edge.weightMinutes),
    );
    const bounds = constraintBounds(task, duration, projectStartDate, mode);
    const start = Math.max(baseStart, dependencyStart, bounds.lower);
    earlyStart.set(id, start);
    earlyFinish.set(id, start + duration);
  }

  const logicalNetworkFinishMinutes = order.length > 0
    ? Math.max(...order.map((id) => earlyFinish.get(id) ?? 0))
    : 0;
  const scheduledFinishById = new Map<string, number>();
  for (const task of networkTasks) {
    if (DATE_PATTERN.test(task.finishDate ?? "")) {
      scheduledFinishById.set(
        task.id,
        dateToMinutes(projectStartDate, task.finishDate!, mode, "FINISH") + GANTT_MINUTES_PER_DAY,
      );
    }
  }
  // The persisted finish dates describe the current resource-levelled plan.
  // Keep that boundary for the plan summary display, but never feed it into
  // CPM late dates or float: an AUTO task moved by resource balancing is not a
  // dependency constraint and cannot create a second, false critical path.
  const scheduledNetworkFinishMinutes = scheduledFinishById.size > 0
    ? Math.max(...scheduledFinishById.values())
    : 0;
  const networkFinishMinutes = Math.max(logicalNetworkFinishMinutes, scheduledNetworkFinishMinutes);
  const normalizedRequiredFinish = DATE_PATTERN.test(requiredFinishDate)
    ? normalizeTaskFinishDate(requiredFinishDate, mode)
    : "";
  const requiredFinishMinutes = normalizedRequiredFinish
    ? dateToMinutes(projectStartDate, normalizedRequiredFinish, mode, "FINISH") + GANTT_MINUTES_PER_DAY
    : null;
  // A required finish earlier than the logical network finish is a real
  // deadline conflict and must produce negative float. A later required
  // finish is only slack and must not extend the project's longest-path
  // calculation.
  const cpmFinishMinutes = requiredFinishMinutes !== null
    && requiredFinishMinutes < logicalNetworkFinishMinutes
    ? requiredFinishMinutes
    : logicalNetworkFinishMinutes;
  const backwardFinishMinutes = cpmFinishMinutes;
  const lateStart = new Map<string, number>();
  const lateFinish = new Map<string, number>();
  const ancestorFinishStartCeiling = (task: CpmGanttTask, duration: number) => {
    const ceilings: number[] = [];
    let parentId = task.parentId ?? null;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = taskById.get(parentId);
      if (!parent) break;
      // A rolled-up parent date describes its children; it is not a CPM
      // restriction. Only an explicitly locked parent boundary may cap a
      // child late date. Otherwise a local zero float can be mistaken for a
      // project-level critical path.
      if (
        String(parent.parentBoundaryMode ?? "").toUpperCase() === "LOCKED"
        && DATE_PATTERN.test(parent.finishDate ?? "")
      ) {
        const finishMinutes = dateToMinutes(projectStartDate, parent.finishDate!, mode, "FINISH")
          + GANTT_MINUTES_PER_DAY;
        ceilings.push(finishMinutes - duration);
      }
      parentId = parent.parentId ?? null;
    }
    return ceilings.length > 0 ? Math.min(...ceilings) : Number.POSITIVE_INFINITY;
  };
  for (const id of [...order].reverse()) {
    const task = networkTaskById.get(id)!;
    const duration = durationById.get(id) ?? 0;
    const successorLimit = Math.min(
      Number.POSITIVE_INFINITY,
      ...(outgoing.get(id) ?? []).map((edge) => (lateStart.get(edge.successorTaskId) ?? backwardFinishMinutes) - edge.weightMinutes),
    );
    const bounds = constraintBounds(task, duration, projectStartDate, mode);
    const start = Math.min(
      successorLimit === Number.POSITIVE_INFINITY ? backwardFinishMinutes - duration : successorLimit,
      bounds.upper,
      ancestorFinishStartCeiling(task, duration),
    );
    lateStart.set(id, start);
    lateFinish.set(id, start + duration);
  }

  for (const task of networkTasks) {
    if (!schedulableIds.has(task.id)) {
      metricsByTaskId.set(task.id, emptyMetrics());
      continue;
    }
    if (cycleIds.has(task.id) || invalidDependencyIds.has(task.id)) {
      metricsByTaskId.set(task.id, emptyMetrics("INVALID_DEPENDENCY"));
      continue;
    }
    const es = earlyStart.get(task.id)!;
    const ef = earlyFinish.get(task.id)!;
    const ls = lateStart.get(task.id)!;
    const lf = lateFinish.get(task.id)!;
    // Total float is the CPM definition: late start minus early start. It is
    // intentionally independent from the persisted resource-levelled bar.
    const totalFloatMinutes = ls - es;
    const edgeFloat = (outgoing.get(task.id) ?? []).map((edge) => (
      (earlyStart.get(edge.successorTaskId) ?? cpmFinishMinutes)
      - (es + edge.weightMinutes)
    ));
    const rawFreeFloatMinutes = edgeFloat.length > 0
      ? Math.min(...edgeFloat)
      : cpmFinishMinutes - ef;
    // Free float cannot exceed total float, including when a locked ancestor
    // boundary or an early required finish produces negative slack.
    const freeFloatMinutes = Math.min(rawFreeFloatMinutes, totalFloatMinutes);
    const completed = Number(task.progress ?? 0) >= 100;
    const scheduleStatus = completed ? "NORMAL" : statusForFloat(totalFloatMinutes);
    // A hard deadline conflict can make the mathematically derived late
    // window precede the early window. Keep the conflict visible through the
    // negative float/status, but do not render an impossible date ordering.
    const displayedLateStart = Math.max(ls, es);
    const displayedLateFinish = Math.max(lf, ef, displayedLateStart + duration);
    metricsByTaskId.set(task.id, {
      earlyStartDate: dateFromMinutes(projectStartDate, es, mode),
      earlyFinishDate: finishDateFromMinutes(projectStartDate, ef, es, mode),
      lateStartDate: dateFromMinutes(projectStartDate, displayedLateStart, mode),
      lateFinishDate: finishDateFromMinutes(projectStartDate, displayedLateFinish, displayedLateStart, mode),
      totalFloatMinutes,
      freeFloatMinutes,
      scheduleStatus,
      // Completed work remains in the historical dependency calculation so a
      // late actual finish can move successors, but it no longer consumes the
      // active critical-path highlight or reports an unresolved warning.
      isCritical: false,
    });
  }

  // Project critical paths are the longest finish-to-start paths through the
  // executable leaf network. A zero float caused solely by a local hard
  // boundary is still a schedule warning, but it must not be presented as a
  // project critical path. Keep every tied predecessor so parallel longest
  // paths are all returned rather than selecting an arbitrary single route.
  const projectCriticalTaskIds = new Set<string>();
  const criticalEndIds = order.filter((id) => (
    (earlyFinish.get(id) ?? Number.NEGATIVE_INFINITY) === logicalNetworkFinishMinutes
  ));
  const collectCriticalAncestors = (taskId: string, visiting = new Set<string>()) => {
    if (visiting.has(taskId)) return;
    const nextVisiting = new Set(visiting).add(taskId);
    const task = networkTaskById.get(taskId);
    if (task && Number(task.progress ?? 0) < 100) {
      projectCriticalTaskIds.add(taskId);
    }
    const taskStart = earlyStart.get(taskId);
    if (taskStart == null) return;
    for (const edge of incoming.get(taskId) ?? []) {
      const predecessorStart = earlyStart.get(edge.predecessorTaskId);
      if (predecessorStart == null) continue;
      if (predecessorStart + edge.weightMinutes === taskStart) {
        collectCriticalAncestors(edge.predecessorTaskId, nextVisiting);
      }
    }
  };
  criticalEndIds.forEach((taskId) => collectCriticalAncestors(taskId));
  const strictProjectCriticalTaskIds = new Set<string>();
  projectCriticalTaskIds.forEach((taskId) => {
    const metrics = metricsByTaskId.get(taskId);
    if (!metrics) return;
    // CPM criticality has a strict meaning: the activity lies on a longest
    // project path and has exactly zero total float. Negative float is a
    // deadline/boundary conflict, not a critical-path marker.
    if (metrics.totalFloatMinutes !== 0 || metrics.scheduleStatus === "NEGATIVE_FLOAT") return;
    metrics.isCritical = true;
    metrics.scheduleStatus = "CRITICAL";
    strictProjectCriticalTaskIds.add(taskId);
  });

  const aggregateSummary = (taskId: string, visiting = new Set<string>()): GanttCpmMetrics => {
    const existing = metricsByTaskId.get(taskId);
    if (existing) return existing;
    if (visiting.has(taskId)) return emptyMetrics("INVALID_DEPENDENCY");
    const nextVisiting = new Set(visiting).add(taskId);
    const childMetrics = (childrenByParentId.get(taskId) ?? []).map((id) => aggregateSummary(id, nextVisiting));
    const calculated = childMetrics.filter((item) => item.totalFloatMinutes !== null);
    if (calculated.length === 0) {
      const status = childMetrics.some((item) => item.scheduleStatus === "INVALID_DEPENDENCY")
        ? "INVALID_DEPENDENCY"
        : "UNSCHEDULED";
      const metrics = emptyMetrics(status);
      metricsByTaskId.set(taskId, metrics);
      return metrics;
    }
    const totalFloatMinutes = Math.min(...calculated.map((item) => item.totalFloatMinutes!));
    // A summary row is a WBS roll-up, never an executable activity. Its
    // status must be derived from the rolled-up float instead of inheriting a
    // child's CRITICAL label. Otherwise every ancestor of a critical leaf is
    // persisted as another critical task and the UI shows duplicated paths.
    const status = childMetrics.some((item) => item.scheduleStatus === "INVALID_DEPENDENCY")
      ? "INVALID_DEPENDENCY"
      : statusForFloat(totalFloatMinutes);
    const metrics: GanttCpmMetrics = {
      earlyStartDate: calculated.map((item) => item.earlyStartDate).filter(Boolean).sort()[0] ?? "",
      earlyFinishDate: calculated.map((item) => item.earlyFinishDate).filter(Boolean).sort().at(-1) ?? "",
      lateStartDate: calculated.map((item) => item.lateStartDate).filter(Boolean).sort()[0] ?? "",
      lateFinishDate: calculated.map((item) => item.lateFinishDate).filter(Boolean).sort().at(-1) ?? "",
      totalFloatMinutes,
      freeFloatMinutes: Math.min(...calculated.map((item) => item.freeFloatMinutes ?? Number.POSITIVE_INFINITY)),
      scheduleStatus: status,
      // Summary nodes express WBS structure, not an independently executable
      // activity. Only terminal nodes may belong to a critical path; otherwise
      // every ancestor duplicates its descendant's critical marker.
      isCritical: false,
    };
    if (metrics.freeFloatMinutes === Number.POSITIVE_INFINITY) metrics.freeFloatMinutes = null;
    metricsByTaskId.set(taskId, metrics);
    return metrics;
  };
  tasks.filter((task) => childrenByParentId.has(task.id)).forEach((task) => aggregateSummary(task.id));
  cycleIds.forEach((id) => metricsByTaskId.set(id, emptyMetrics("INVALID_DEPENDENCY")));

  const calculatedFinishDate = order.length > 0
    ? finishDateFromMinutes(projectStartDate, networkFinishMinutes, 0, mode)
    : "";
  return {
    projectStartDate,
    calculatedFinishDate,
    requiredFinishVarianceMinutes: requiredFinishMinutes === null
      ? null
      : requiredFinishMinutes - logicalNetworkFinishMinutes,
    hasDependencyCycle: cycleIds.size > 0,
    projectCriticalTaskIds: strictProjectCriticalTaskIds,
    metricsByTaskId,
  };
};

export const ganttFloatDays = (minutes: number | null | undefined) => (
  minutes == null ? null : Math.round((minutes / GANTT_MINUTES_PER_DAY) * 100) / 100
);
