export interface GanttDateParts {
  year: string;
  month: string;
  day: string;
}

interface GanttDateBuildOptions {
  allowShortSegments?: boolean;
  currentYear?: number;
}

const EMPTY_DATE_PARTS: GanttDateParts = { year: "", month: "", day: "" };

export const splitGanttDate = (value: string): GanttDateParts => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return { ...EMPTY_DATE_PARTS };
  return { year: match[1], month: match[2], day: match[3] };
};

export const areGanttDatePartsEmpty = (parts: GanttDateParts): boolean => (
  !parts.year && !parts.month && !parts.day
);

export const normalizeEditedGanttYear = (
  previousYear: string,
  nextYear: string,
  currentYear = new Date().getFullYear(),
): string => {
  const previousDigits = previousYear.replace(/\D/g, "");
  const nextDigits = nextYear.replace(/\D/g, "").slice(0, 4);
  const replacedOnlyLastTwoDigits = previousDigits.length === 4
    && nextDigits.length === 4
    && nextDigits !== previousDigits
    && nextDigits.slice(0, 2) === previousDigits.slice(0, 2);
  if (!replacedOnlyLastTwoDigits) return nextDigits;
  return `${String(currentYear).slice(0, 2)}${nextDigits.slice(2)}`;
};

export const isValidGanttDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
};

export const buildGanttDate = (
  parts: GanttDateParts,
  options: GanttDateBuildOptions = {},
): string | null => {
  if (areGanttDatePartsEmpty(parts)) return "";

  const allowShortSegments = options.allowShortSegments ?? false;
  const currentYear = options.currentYear ?? new Date().getFullYear();
  const digits = {
    year: parts.year.replace(/\D/g, ""),
    month: parts.month.replace(/\D/g, ""),
    day: parts.day.replace(/\D/g, ""),
  };

  let year = digits.year;
  if (allowShortSegments && year.length === 2) {
    year = `${String(currentYear).slice(0, 2)}${year}`;
  }
  if (year.length !== 4) return null;
  if (allowShortSegments) {
    if (digits.month.length < 1 || digits.day.length < 1) return null;
  } else if (digits.month.length !== 2 || digits.day.length !== 2) {
    return null;
  }

  const month = digits.month.padStart(2, "0");
  const day = digits.day.padStart(2, "0");
  const value = `${year}-${month}-${day}`;
  return isValidGanttDate(value) ? value : null;
};
