import chineseDays from "chinese-days/dist/index.min.js";

import { normalizeGanttRelativeOffset } from "@/lib/gantt-relative-time";

const { isWorkday } = chineseDays;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const parseCalendarDate = (value: string): Date => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

const formatCalendarDate = (value: Date): string => value.toISOString().slice(0, 10);

export const GANTT_HOURS_PER_DAY = 7.5;
export const GANTT_DURATION_STEP_DAYS = 0.5;

export const GANTT_CALENDAR_MODES = ["CALENDAR_DAYS", "WORKING_DAYS"] as const;
export type GanttCalendarMode = typeof GANTT_CALENDAR_MODES[number];

export const normalizeGanttCalendarMode = (value: unknown): GanttCalendarMode => (
  value === "WORKING_DAYS" ? "WORKING_DAYS" : "CALENDAR_DAYS"
);

export const roundGanttHours = (value: number): number => (
  Math.round((Number.isFinite(value) ? Math.max(0, value) : 0) * 100) / 100
);

export const normalizeGanttDurationDays = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(
    GANTT_DURATION_STEP_DAYS,
    Math.round(value / GANTT_DURATION_STEP_DAYS) * GANTT_DURATION_STEP_DAYS,
  );
};

export const isValidGanttDurationDays = (value: number): boolean => (
  Number.isFinite(value)
  && value >= 0
  && Math.abs(value / GANTT_DURATION_STEP_DAYS - Math.round(value / GANTT_DURATION_STEP_DAYS)) < 0.000_001
);

export const estimatedHoursForDuration = (durationDays: number): number => (
  roundGanttHours(normalizeGanttDurationDays(durationDays) * GANTT_HOURS_PER_DAY)
);

export const isGanttWorkingDate = (date: Date | string) => {
  const normalized = typeof date === "string" ? parseCalendarDate(date) : date;
  return isWorkday(formatCalendarDate(normalized));
};

const isWorkingDate = (date: Date) => isGanttWorkingDate(date);

const moveToWorkingDate = (date: Date, direction: 1 | -1) => {
  const result = new Date(date.getTime());
  while (!isWorkingDate(result)) {
    result.setUTCDate(result.getUTCDate() + direction);
  }
  return result;
};

export const normalizeTaskStartDate = (value: string, mode: GanttCalendarMode): string => {
  if (!value || mode === "CALENDAR_DAYS") return value;
  return formatCalendarDate(moveToWorkingDate(parseCalendarDate(value), 1));
};

export const normalizeTaskFinishDate = (value: string, mode: GanttCalendarMode): string => {
  if (!value || mode === "CALENDAR_DAYS") return value;
  return formatCalendarDate(moveToWorkingDate(parseCalendarDate(value), -1));
};

export const calculateTaskFinishDate = (
  startDate: string,
  durationDays: number,
  mode: GanttCalendarMode,
): string => {
  const duration = normalizeGanttDurationDays(durationDays);
  if (!startDate || duration <= 0) return "";
  const occupiedDays = Math.ceil(duration);
  if (mode === "CALENDAR_DAYS") {
    return formatCalendarDate(new Date(parseCalendarDate(startDate).getTime() + (occupiedDays - 1) * MS_PER_DAY));
  }

  const date = moveToWorkingDate(parseCalendarDate(startDate), 1);
  let counted = 1;
  while (counted < occupiedDays) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isWorkingDate(date)) counted += 1;
  }
  return formatCalendarDate(date);
};

export const calculateTaskStartDate = (
  finishDate: string,
  durationDays: number,
  mode: GanttCalendarMode,
): string => {
  const duration = normalizeGanttDurationDays(durationDays);
  if (!finishDate || duration <= 0) return "";
  const occupiedDays = Math.ceil(duration);
  if (mode === "CALENDAR_DAYS") {
    return formatCalendarDate(new Date(parseCalendarDate(finishDate).getTime() - (occupiedDays - 1) * MS_PER_DAY));
  }

  const date = moveToWorkingDate(parseCalendarDate(finishDate), -1);
  let counted = 1;
  while (counted < occupiedDays) {
    date.setUTCDate(date.getUTCDate() - 1);
    if (isWorkingDate(date)) counted += 1;
  }
  return formatCalendarDate(date);
};

export const calculateTaskDurationDays = (
  startDate: string,
  finishDate: string,
  mode: GanttCalendarMode,
): number => {
  if (!startDate || !finishDate || finishDate < startDate) return 1;
  if (mode === "CALENDAR_DAYS") {
    return Math.max(1, Math.round((parseCalendarDate(finishDate).getTime() - parseCalendarDate(startDate).getTime()) / MS_PER_DAY) + 1);
  }

  const cursor = parseCalendarDate(startDate);
  const finish = parseCalendarDate(finishDate);
  let count = 0;
  while (cursor <= finish) {
    if (isWorkingDate(cursor)) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return Math.max(1, count);
};

/**
 * Returns the working allocation buckets occupied by a task. A 0.5-day task
 * consumes half of the daily capacity on its single calendar day; 1.5 days
 * consumes one full bucket followed by one half bucket. Dates stay day-based
 * so the existing Gantt model remains compatible with Project and Excel IO.
 */
export const ganttTaskWorkSlots = (
  startDate: string,
  durationDays: number,
  mode: GanttCalendarMode,
): Array<{ date: string; portion: number }> => {
  const duration = normalizeGanttDurationDays(durationDays);
  if (!startDate || duration <= 0) return [];
  const slots: Array<{ date: string; portion: number }> = [];
  const cursor = mode === "WORKING_DAYS"
    ? moveToWorkingDate(parseCalendarDate(startDate), 1)
    : parseCalendarDate(startDate);
  let remaining = duration;
  while (remaining > 0.000_001) {
    if (mode === "CALENDAR_DAYS" || isWorkingDate(cursor)) {
      const portion = Math.min(1, remaining);
      slots.push({ date: formatCalendarDate(cursor), portion });
      remaining = Math.max(0, remaining - portion);
    }
    if (remaining > 0.000_001) cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return slots;
};

export const nextTaskStartDate = (finishDate: string, mode: GanttCalendarMode): string => {
  if (!finishDate) return "";
  const next = new Date(parseCalendarDate(finishDate).getTime() + MS_PER_DAY);
  return mode === "WORKING_DAYS" ? formatCalendarDate(moveToWorkingDate(next, 1)) : formatCalendarDate(next);
};

export const shiftTaskDate = (value: string, days: number, mode: GanttCalendarMode): string => {
  if (!value || days === 0) return value;
  const direction: 1 | -1 = days > 0 ? 1 : -1;
  const date = parseCalendarDate(value);
  let remaining = Math.abs(Math.trunc(days));
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + direction);
    if (mode === "CALENDAR_DAYS" || isWorkingDate(date)) remaining -= 1;
  }
  return formatCalendarDate(date);
};

/** Materializes an abstract T0 offset after the project receives a real T0. */
export const materializeGanttOffsetDate = (
  projectT0: string,
  offset: number,
  mode: GanttCalendarMode,
): string => {
  const anchor = normalizeTaskStartDate(projectT0, mode);
  return shiftTaskDate(anchor, Math.trunc(normalizeGanttRelativeOffset(offset)), mode);
};

/** Converts a concrete date back to its project-calendar workday offset. */
export const ganttOffsetFromMaterializedDate = (
  projectT0: string,
  value: string,
  mode: GanttCalendarMode,
): number => {
  const anchor = normalizeTaskStartDate(projectT0, mode);
  if (mode === "CALENDAR_DAYS") {
    return normalizeGanttRelativeOffset(Math.round(
      (parseCalendarDate(value).getTime() - parseCalendarDate(anchor).getTime()) / MS_PER_DAY,
    ));
  }
  if (value <= anchor) return 0;
  let offset = 0;
  let cursor = anchor;
  while (cursor < value) {
    cursor = shiftTaskDate(cursor, 1, mode);
    offset += 1;
  }
  return normalizeGanttRelativeOffset(offset);
};
