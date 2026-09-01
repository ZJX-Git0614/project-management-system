import {
  isGanttWorkingDate,
  type GanttCalendarMode,
} from "@/lib/gantt-calendar";
import { formatGanttDate, parseGanttDate } from "@/lib/gantt";

/**
 * Canonical schedule modes used by the WBS editor.
 *
 * The API still accepts the historical MANUAL/FIXED/LOCKED values. They are
 * normalized to DATES_FIXED so old plans keep their dates instead of being
 * silently rescheduled.
 */
export type GanttScheduleMode =
  | "AUTO"
  | "DURATION_FORWARD"
  | "DURATION_BACKWARD"
  | "DATES_FIXED";

export type GanttHalfDay = "AM" | "PM";
export type GanttUserPriority = "LOW" | "MEDIUM" | "HIGH";
export type GanttEffectivePriority = GanttUserPriority | "HIGHEST";
export const GANTT_FS_DEPENDENCY_TYPE = 1;
export const UNSUPPORTED_GANTT_DEPENDENCY_REASON = "当前阶段仅支持完成-开始（FS）关系";

/**
 * The WBS editor, automatic scheduler, CPM calculation, and baseline release
 * must agree on the same dependency contract. Keep the check here instead of
 * letting each caller infer Project's numeric relationship values differently.
 */
export const isGanttFsDependency = (dependency: { type?: number | null }) => (
  Number(dependency.type ?? GANTT_FS_DEPENDENCY_TYPE) === GANTT_FS_DEPENDENCY_TYPE
);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const isValidPlanningDate = (value: unknown): value is string => (
  typeof value === "string" && DATE_PATTERN.test(value)
);

export const normalizeGanttScheduleMode = (value: unknown): GanttScheduleMode => {
  const normalized = String(value ?? "AUTO").trim().toUpperCase();
  if (normalized === "DURATION_FORWARD" || normalized === "FORWARD") return "DURATION_FORWARD";
  if (normalized === "DURATION_BACKWARD" || normalized === "BACKWARD") return "DURATION_BACKWARD";
  if (normalized === "DATES_FIXED" || normalized === "DATE_FIXED") return "DATES_FIXED";
  if (normalized === "MANUAL" || normalized === "FIXED" || normalized === "LOCKED") return "DATES_FIXED";
  return "AUTO";
};

export const normalizeGanttHalfDay = (value: unknown, fallback: GanttHalfDay = "AM"): GanttHalfDay => (
  String(value ?? fallback).trim().toUpperCase() === "PM" ? "PM" : "AM"
);

export const normalizeGanttUserPriority = (value: unknown): GanttUserPriority => {
  const normalized = String(value ?? "MEDIUM").trim().toUpperCase();
  if (normalized === "LOW" || normalized === "1" || normalized === "低") return "LOW";
  if (normalized === "HIGH" || normalized === "3" || normalized === "高") return "HIGH";
  return "MEDIUM";
};

export const priorityRank: Record<GanttEffectivePriority, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  HIGHEST: 4,
};

/**
 * The resource scheduler consumes a numeric value. Keep that value derived
 * from the same effective priority shown in the WBS so resource ordering,
 * dependency commitments and critical-path work cannot drift apart.
 */
export const ganttSchedulePriorityFor = (priority: GanttEffectivePriority): number => ({
  LOW: 250,
  MEDIUM: 500,
  HIGH: 750,
  HIGHEST: 1000,
}[priority]);

export interface GanttPriorityInput {
  userPriority?: unknown;
  isCritical?: boolean;
  /**
   * A leaf task that participates in an FS relationship is a dependency
   * commitment whether it is the predecessor or successor. Keep the legacy
   * predecessor field for callers that have not been migrated yet.
   */
  hasSupportedDependency?: boolean;
  hasSupportedPredecessor?: boolean;
}

export interface GanttPriorityResult {
  userPriority: GanttUserPriority;
  effectivePriority: GanttEffectivePriority;
  readOnly: boolean;
  reason: "CRITICAL_PATH" | "DEPENDENCY" | "USER";
}

export const deriveGanttPriority = (input: GanttPriorityInput): GanttPriorityResult => {
  const userPriority = normalizeGanttUserPriority(input.userPriority);
  if (input.isCritical) {
    return {
      userPriority,
      effectivePriority: "HIGHEST",
      readOnly: true,
      reason: "CRITICAL_PATH",
    };
  }
  if (input.hasSupportedDependency || input.hasSupportedPredecessor) {
    return {
      userPriority,
      effectivePriority: "HIGH",
      readOnly: true,
      reason: "DEPENDENCY",
    };
  }
  return {
    userPriority,
    effectivePriority: userPriority,
    readOnly: false,
    reason: "USER",
  };
};

export interface GanttTimePoint {
  date: string;
  slot: GanttHalfDay;
}

const slotIndex = (slot: GanttHalfDay) => (slot === "PM" ? 1 : 0);

const nextDate = (date: string, mode: GanttCalendarMode, direction: 1 | -1): string => {
  const cursor = parseGanttDate(date);
  do {
    cursor.setUTCDate(cursor.getUTCDate() + direction);
  } while (mode === "WORKING_DAYS" && !isGanttWorkingDate(cursor));
  return formatGanttDate(cursor);
};

const normalizeStartPoint = (point: GanttTimePoint, mode: GanttCalendarMode): GanttTimePoint => {
  if (mode !== "WORKING_DAYS" || isGanttWorkingDate(point.date)) return point;
  let date = point.date;
  while (!isGanttWorkingDate(date)) date = nextDate(date, mode, 1);
  return { date, slot: point.slot };
};

const normalizeFinishPoint = (point: GanttTimePoint, mode: GanttCalendarMode): GanttTimePoint => {
  if (mode !== "WORKING_DAYS" || isGanttWorkingDate(point.date)) return point;
  let date = point.date;
  while (!isGanttWorkingDate(date)) date = nextDate(date, mode, -1);
  return { date, slot: point.slot };
};

const advanceHalfDays = (
  point: GanttTimePoint,
  halfDays: number,
  mode: GanttCalendarMode,
): GanttTimePoint => {
  let current = normalizeStartPoint(point, mode);
  for (let index = 0; index < halfDays; index += 1) {
    if (index === halfDays - 1) break;
    if (current.slot === "AM") {
      current = { ...current, slot: "PM" };
    } else {
      current = { date: nextDate(current.date, mode, 1), slot: "AM" };
    }
  }
  return current;
};

const retreatHalfDays = (
  point: GanttTimePoint,
  halfDays: number,
  mode: GanttCalendarMode,
): GanttTimePoint => {
  let current = normalizeFinishPoint(point, mode);
  for (let index = 0; index < halfDays; index += 1) {
    if (index === halfDays - 1) break;
    if (current.slot === "PM") {
      current = { ...current, slot: "AM" };
    } else {
      current = { date: nextDate(current.date, mode, -1), slot: "PM" };
    }
  }
  return current;
};

export const normalizePlanningDuration = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 2) / 2;
};

export const planningDurationToHalfDays = (durationDays: number): number => (
  Math.max(0, Math.round(normalizePlanningDuration(durationDays) * 2))
);

export interface DerivedGanttDates {
  startDate: string;
  startSlot: GanttHalfDay;
  finishDate: string;
  finishSlot: GanttHalfDay;
  durationDays: number;
}

export interface ResolvedGanttPlan extends DerivedGanttDates {
  taskMode: GanttScheduleMode;
  error?: string;
}

export const deriveForwardGanttDates = (input: {
  startDate: string;
  startSlot?: GanttHalfDay;
  durationDays: number;
  mode: GanttCalendarMode;
}): DerivedGanttDates => {
  const durationDays = normalizePlanningDuration(input.durationDays);
  const halfDays = planningDurationToHalfDays(durationDays);
  if (!isValidPlanningDate(input.startDate) || halfDays === 0) {
    return {
      startDate: isValidPlanningDate(input.startDate) ? input.startDate : "",
      startSlot: normalizeGanttHalfDay(input.startSlot),
      finishDate: "",
      finishSlot: "PM",
      durationDays,
    };
  }
  const start = normalizeStartPoint({ date: input.startDate, slot: normalizeGanttHalfDay(input.startSlot) }, input.mode);
  const finish = advanceHalfDays(start, halfDays, input.mode);
  return {
    startDate: start.date,
    startSlot: start.slot,
    finishDate: finish.date,
    finishSlot: finish.slot,
    durationDays,
  };
};

export const deriveBackwardGanttDates = (input: {
  finishDate: string;
  finishSlot?: GanttHalfDay;
  durationDays: number;
  mode: GanttCalendarMode;
}): DerivedGanttDates => {
  const durationDays = normalizePlanningDuration(input.durationDays);
  const halfDays = planningDurationToHalfDays(durationDays);
  if (!isValidPlanningDate(input.finishDate) || halfDays === 0) {
    return {
      startDate: "",
      startSlot: "AM",
      finishDate: isValidPlanningDate(input.finishDate) ? input.finishDate : "",
      finishSlot: normalizeGanttHalfDay(input.finishSlot, "PM"),
      durationDays,
    };
  }
  const finish = normalizeFinishPoint({ date: input.finishDate, slot: normalizeGanttHalfDay(input.finishSlot, "PM") }, input.mode);
  const start = retreatHalfDays(finish, halfDays, input.mode);
  return {
    startDate: start.date,
    startSlot: start.slot,
    finishDate: finish.date,
    finishSlot: finish.slot,
    durationDays,
  };
};

export const deriveDatesFixedDuration = (input: {
  startDate: string;
  startSlot?: GanttHalfDay;
  finishDate: string;
  finishSlot?: GanttHalfDay;
  mode: GanttCalendarMode;
}): DerivedGanttDates => {
  if (!isValidPlanningDate(input.startDate) || !isValidPlanningDate(input.finishDate)) {
    return {
      startDate: input.startDate || "",
      startSlot: normalizeGanttHalfDay(input.startSlot),
      finishDate: input.finishDate || "",
      finishSlot: normalizeGanttHalfDay(input.finishSlot, "PM"),
      durationDays: 0,
    };
  }
  const start = normalizeStartPoint({ date: input.startDate, slot: normalizeGanttHalfDay(input.startSlot) }, input.mode);
  const finish = normalizeFinishPoint({ date: input.finishDate, slot: normalizeGanttHalfDay(input.finishSlot, "PM") }, input.mode);
  if (start.date > finish.date || (start.date === finish.date && slotIndex(start.slot) > slotIndex(finish.slot))) {
    return {
      startDate: start.date,
      startSlot: start.slot,
      finishDate: finish.date,
      finishSlot: finish.slot,
      durationDays: 0,
    };
  }
  let cursor = start;
  let halfDays = 1;
  while (cursor.date !== finish.date || cursor.slot !== finish.slot) {
    cursor = advanceHalfDays(cursor, 2, input.mode);
    halfDays += 1;
    if (halfDays > 200000) break;
  }
  return {
    startDate: start.date,
    startSlot: start.slot,
    finishDate: finish.date,
    finishSlot: finish.slot,
    durationDays: halfDays / 2,
  };
};

/** Resolves only the fields owned by a task's selected scheduling mode. */
export const resolveGanttTaskPlan = (input: {
  taskMode?: unknown;
  startDate?: string;
  startSlot?: GanttHalfDay;
  finishDate?: string;
  finishSlot?: GanttHalfDay;
  durationDays?: number;
  mode: GanttCalendarMode;
}): ResolvedGanttPlan => {
  const taskMode = normalizeGanttScheduleMode(input.taskMode);
  const startDate = input.startDate?.trim() ?? "";
  const finishDate = input.finishDate?.trim() ?? "";
  const durationDays = normalizePlanningDuration(input.durationDays ?? 0);
  const startSlot = normalizeGanttHalfDay(input.startSlot);
  const finishSlot = normalizeGanttHalfDay(input.finishSlot, "PM");
  const empty: ResolvedGanttPlan = {
    taskMode,
    startDate: isValidPlanningDate(startDate) ? startDate : "",
    startSlot,
    finishDate: isValidPlanningDate(finishDate) ? finishDate : "",
    finishSlot,
    durationDays,
  };

  if (taskMode === "DURATION_FORWARD") {
    if (!isValidPlanningDate(startDate) || durationDays <= 0) {
      return { ...empty, error: "工期正排需要填写计划开始时间和工期" };
    }
    return { taskMode, ...deriveForwardGanttDates({ startDate, startSlot, durationDays, mode: input.mode }) };
  }
  if (taskMode === "DURATION_BACKWARD") {
    if (!isValidPlanningDate(finishDate) || durationDays <= 0) {
      return { ...empty, error: "工期倒排需要填写计划完成时间和工期" };
    }
    return { taskMode, ...deriveBackwardGanttDates({ finishDate, finishSlot, durationDays, mode: input.mode }) };
  }
  if (taskMode === "DATES_FIXED") {
    if (!startDate && !finishDate && durationDays === 0) return empty;
    if (!isValidPlanningDate(startDate) || !isValidPlanningDate(finishDate)) {
      return { ...empty, error: "日期固定需要同时填写计划开始和计划完成时间" };
    }
    const resolved = deriveDatesFixedDuration({ startDate, startSlot, finishDate, finishSlot, mode: input.mode });
    if (resolved.durationDays <= 0) return { taskMode, ...resolved, error: "计划完成时间不能早于计划开始时间" };
    return { taskMode, ...resolved };
  }

  // AUTO tasks can remain unscheduled. With an explicit start and duration,
  // preserve the user anchor; otherwise the scheduler may use dependencies or
  // project/parent boundaries later without inventing a placeholder date.
  if (isValidPlanningDate(startDate) && durationDays > 0) {
    return { taskMode, ...deriveForwardGanttDates({ startDate, startSlot, durationDays, mode: input.mode }) };
  }
  if (isValidPlanningDate(startDate) && isValidPlanningDate(finishDate)) {
    return { taskMode, ...deriveDatesFixedDuration({ startDate, startSlot, finishDate, finishSlot, mode: input.mode }) };
  }
  return empty;
};

export interface GanttCompletionInput {
  progress: unknown;
  actualStartDate?: string;
  actualEndDate?: string;
  today: string;
  previousProgress?: number;
}

export interface GanttCompletionResult {
  progress: number;
  actualStartDate: string;
  actualEndDate: string;
  actualFinishReadOnly: boolean;
  error?: string;
}

export const normalizeGanttCompletion = (input: GanttCompletionInput): GanttCompletionResult => {
  const progress = Number(input.progress);
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    return {
      progress: Number.isInteger(progress) ? Math.max(0, Math.min(100, progress)) : 0,
      actualStartDate: input.actualStartDate ?? "",
      actualEndDate: input.actualEndDate ?? "",
      actualFinishReadOnly: false,
      error: "当前进度必须为 0-100 的整数",
    };
  }
  const actualStartDate = input.actualStartDate ?? "";
  let actualEndDate = input.actualEndDate ?? "";
  if (input.previousProgress === 100 && progress < 100) {
    return {
      progress,
      actualStartDate,
      actualEndDate: "",
      actualFinishReadOnly: false,
    };
  }
  if (actualEndDate && (!isValidPlanningDate(actualEndDate) || actualEndDate > input.today)) {
    return { progress, actualStartDate, actualEndDate, actualFinishReadOnly: progress === 100, error: "实际完成日期只能填写今天或过去日期" };
  }
  if (progress === 100 && !actualEndDate) actualEndDate = input.today;
  if (actualEndDate) {
    return { progress: 100, actualStartDate, actualEndDate, actualFinishReadOnly: true };
  }
  return {
    progress,
    actualStartDate,
    actualEndDate,
    actualFinishReadOnly: false,
  };
};

export interface HardBoundaryConflict {
  taskId: string;
  parentId: string;
  taskCode: string;
  parentCode: string;
  message: string;
}

export const findGanttHardBoundaryConflicts = <T extends {
  id: string;
  parentId?: string | null;
  taskCode?: string;
  startDate?: string;
  finishDate?: string;
  parentBoundaryMode?: string;
}>(tasks: T[]): HardBoundaryConflict[] => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.flatMap((task) => {
    if (!isValidPlanningDate(task.startDate) || !isValidPlanningDate(task.finishDate)) return [];

    const conflicts: HardBoundaryConflict[] = [];
    const visited = new Set<string>([task.id]);
    let parentId = task.parentId ?? "";
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      if (
        String(parent.parentBoundaryMode) === "LOCKED"
        && isValidPlanningDate(parent.startDate)
        && isValidPlanningDate(parent.finishDate)
        && (task.startDate < parent.startDate || task.finishDate > parent.finishDate)
      ) {
        conflicts.push({
          taskId: task.id,
          parentId,
          taskCode: task.taskCode ?? task.id,
          parentCode: parent.taskCode ?? parent.id,
          message: `任务 ${task.taskCode ?? task.id} 超出父任务 ${parent.taskCode ?? parent.id} 的锁定边界`,
        });
      }
      parentId = parent.parentId ?? "";
    }
    return conflicts;
  });
};

export const validateFsDependencies = (dependencies: Array<{ type?: number | null }>) => (
  dependencies.flatMap((dependency, index) => (
    isGanttFsDependency(dependency)
      ? []
      : [{ index, message: `${UNSUPPORTED_GANTT_DEPENDENCY_REASON}，请先处理其他关系后再自动排期或发布基线` }]
  ))
);
