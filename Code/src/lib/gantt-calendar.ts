import chineseDays from "chinese-days/dist/index.min.js";

import { MS_PER_DAY, formatGanttDate, parseGanttDate } from "@/lib/gantt";

const { isWorkday } = chineseDays;

export const GANTT_HOURS_PER_DAY = 7.5;

export const GANTT_CALENDAR_MODES = ["CALENDAR_DAYS", "WORKING_DAYS"] as const;
export type GanttCalendarMode = typeof GANTT_CALENDAR_MODES[number];

export const normalizeGanttCalendarMode = (value: unknown): GanttCalendarMode => (
  value === "WORKING_DAYS" ? "WORKING_DAYS" : "CALENDAR_DAYS"
);

export const roundGanttHours = (value: number): number => (
  Math.round((Number.isFinite(value) ? Math.max(0, value) : 0) * 100) / 100
);

export const estimatedHoursForDuration = (durationDays: number): number => (
  roundGanttHours(Math.max(1, Math.trunc(durationDays)) * GANTT_HOURS_PER_DAY)
);

const isWorkingDate = (date: Date) => isWorkday(formatGanttDate(date));

const moveToWorkingDate = (date: Date, direction: 1 | -1) => {
  const result = new Date(date.getTime());
  while (!isWorkingDate(result)) {
    result.setUTCDate(result.getUTCDate() + direction);
  }
  return result;
};

export const normalizeTaskStartDate = (value: string, mode: GanttCalendarMode): string => {
  if (!value || mode === "CALENDAR_DAYS") return value;
  return formatGanttDate(moveToWorkingDate(parseGanttDate(value), 1));
};

export const calculateTaskFinishDate = (
  startDate: string,
  durationDays: number,
  mode: GanttCalendarMode,
): string => {
  if (!startDate) return "";
  const duration = Math.max(1, Math.trunc(durationDays));
  if (mode === "CALENDAR_DAYS") {
    return formatGanttDate(new Date(parseGanttDate(startDate).getTime() + (duration - 1) * MS_PER_DAY));
  }

  const date = moveToWorkingDate(parseGanttDate(startDate), 1);
  let counted = 1;
  while (counted < duration) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isWorkingDate(date)) counted += 1;
  }
  return formatGanttDate(date);
};

export const calculateTaskStartDate = (
  finishDate: string,
  durationDays: number,
  mode: GanttCalendarMode,
): string => {
  if (!finishDate) return "";
  const duration = Math.max(1, Math.trunc(durationDays));
  if (mode === "CALENDAR_DAYS") {
    return formatGanttDate(new Date(parseGanttDate(finishDate).getTime() - (duration - 1) * MS_PER_DAY));
  }

  const date = moveToWorkingDate(parseGanttDate(finishDate), -1);
  let counted = 1;
  while (counted < duration) {
    date.setUTCDate(date.getUTCDate() - 1);
    if (isWorkingDate(date)) counted += 1;
  }
  return formatGanttDate(date);
};

export const calculateTaskDurationDays = (
  startDate: string,
  finishDate: string,
  mode: GanttCalendarMode,
): number => {
  if (!startDate || !finishDate || finishDate < startDate) return 1;
  if (mode === "CALENDAR_DAYS") {
    return Math.max(1, Math.round((parseGanttDate(finishDate).getTime() - parseGanttDate(startDate).getTime()) / MS_PER_DAY) + 1);
  }

  const cursor = parseGanttDate(startDate);
  const finish = parseGanttDate(finishDate);
  let count = 0;
  while (cursor <= finish) {
    if (isWorkingDate(cursor)) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return Math.max(1, count);
};

export const nextTaskStartDate = (finishDate: string, mode: GanttCalendarMode): string => {
  if (!finishDate) return "";
  const next = new Date(parseGanttDate(finishDate).getTime() + MS_PER_DAY);
  return mode === "WORKING_DAYS" ? formatGanttDate(moveToWorkingDate(next, 1)) : formatGanttDate(next);
};

export const shiftTaskDate = (value: string, days: number, mode: GanttCalendarMode): string => {
  if (!value || days === 0) return value;
  const direction: 1 | -1 = days > 0 ? 1 : -1;
  const date = parseGanttDate(value);
  let remaining = Math.abs(Math.trunc(days));
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + direction);
    if (mode === "CALENDAR_DAYS" || isWorkingDate(date)) remaining -= 1;
  }
  return formatGanttDate(date);
};
