/**
 * Internal-only anchor used to run the existing date scheduler as an abstract
 * working-day index. It is never persisted or returned to the browser.
 */
export const GANTT_RELATIVE_T0_ANCHOR = "2000-01-03";

export const isGanttRelativeOffset = (value: unknown): value is number => (
  typeof value === "number" && Number.isFinite(value) && value >= 0
);

export const normalizeGanttRelativeOffset = (value: number): number => (
  Math.round(Math.max(0, value) * 2) / 2
);

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const parseDate = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};
const formatDate = (value: Date) => value.toISOString().slice(0, 10);

export const formatGanttRelativeOffset = (value: number | null | undefined): string => {
  if (!isGanttRelativeOffset(value)) return "--";
  const offset = normalizeGanttRelativeOffset(value);
  return offset === 0 ? "T0" : `T0+${Number.isInteger(offset) ? offset : offset.toFixed(1)}`;
};

/** Relative scheduling deliberately treats every index as a working day. */
export const abstractDateFromGanttOffset = (offset: number): string => (
  formatDate(new Date(
    parseDate(GANTT_RELATIVE_T0_ANCHOR).getTime()
    + Math.trunc(normalizeGanttRelativeOffset(offset)) * MS_PER_DAY,
  ))
);

export const ganttOffsetFromAbstractDate = (value: string): number => (
  normalizeGanttRelativeOffset(Math.round(
    (parseDate(value).getTime() - parseDate(GANTT_RELATIVE_T0_ANCHOR).getTime()) / MS_PER_DAY,
  ))
);
