import {
  calculateTaskDurationDays,
  nextTaskStartDate,
  shiftTaskDate,
  type GanttCalendarMode,
} from "@/lib/gantt-calendar";
import { GANTT_MINUTES_PER_DAY } from "@/lib/gantt-cpm";

const normalizeFloatMinutes = (value: number | null | undefined) => (
  value == null || !Number.isFinite(value) ? null : value
);

const clampPositiveFloatMinutes = (
  floatMinutes: number | null | undefined,
  availableMinutes: number,
) => {
  const normalized = normalizeFloatMinutes(floatMinutes);
  if (normalized == null) return null;
  if (normalized <= 0) return 0;
  return Math.min(normalized, Math.max(0, availableMinutes));
};

const calendarDayDistance = (fromDate: string, toDate: string) => {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
};

/**
 * Converts theoretical CPM float into the remaining float that can be shown
 * after the task's persisted finish without crossing the project boundary.
 */
export const ganttFloatMinutesWithinDateBoundary = (
  taskFinishDate: string,
  floatMinutes: number | null | undefined,
  boundaryFinishDate: string,
  mode: GanttCalendarMode,
  latestFinishDate?: string,
) => {
  const effectiveBoundary = [boundaryFinishDate, latestFinishDate]
    .filter(Boolean)
    .sort()[0] ?? "";
  if (!taskFinishDate || !effectiveBoundary || taskFinishDate >= effectiveBoundary) {
    return clampPositiveFloatMinutes(floatMinutes, 0);
  }

  const firstAvailableDate = nextTaskStartDate(taskFinishDate, mode);
  if (!firstAvailableDate || firstAvailableDate > effectiveBoundary) {
    return clampPositiveFloatMinutes(floatMinutes, 0);
  }

  const availableDays = calculateTaskDurationDays(firstAvailableDate, effectiveBoundary, mode);
  return clampPositiveFloatMinutes(floatMinutes, availableDays * GANTT_MINUTES_PER_DAY);
};

/**
 * Returns the calendar-axis width of a float line. The CPM value is expressed
 * in working/calendar days, while the timeline is always a calendar axis, so
 * the computed width is capped again by the exact visible boundary date.
 */
export const ganttFloatCalendarSpanWithinDateBoundary = (
  taskFinishDate: string,
  floatMinutes: number | null | undefined,
  boundaryFinishDate: string,
  mode: GanttCalendarMode,
  latestFinishDate?: string,
) => {
  const effectiveBoundary = [boundaryFinishDate, latestFinishDate]
    .filter(Boolean)
    .sort()[0] ?? "";
  const clampedMinutes = ganttFloatMinutesWithinDateBoundary(
    taskFinishDate,
    floatMinutes,
    boundaryFinishDate,
    mode,
    latestFinishDate,
  );
  if (!taskFinishDate || !effectiveBoundary || !clampedMinutes || clampedMinutes <= 0) return 0;

  const floatDays = clampedMinutes / GANTT_MINUTES_PER_DAY;
  const wholeDays = Math.floor(floatDays);
  const remainder = floatDays - wholeDays;
  const shifted = wholeDays > 0 ? shiftTaskDate(taskFinishDate, wholeDays, mode) : taskFinishDate;
  const calculatedSpan = calendarDayDistance(taskFinishDate, shifted) + remainder;
  return Math.min(calculatedSpan, calendarDayDistance(taskFinishDate, effectiveBoundary));
};

export const ganttFloatMinutesWithinRelativeBoundary = (
  taskFinishOffsetDays: number,
  floatMinutes: number | null | undefined,
  boundaryFinishOffsetDays: number,
) => clampPositiveFloatMinutes(
  floatMinutes,
  Math.max(0, boundaryFinishOffsetDays - taskFinishOffsetDays) * GANTT_MINUTES_PER_DAY,
);
