import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const nowIso = (): string => new Date().toISOString();

export const createId = (prefix: string): string =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const BEIJING_TIME_ZONE = "Asia/Shanghai";

const toDateParts = (iso: string) => {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: BEIJING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));

  const getPart = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "00";

  return {
    year: getPart("year"),
    month: getPart("month"),
    day: getPart("day"),
    hour: getPart("hour"),
    minute: getPart("minute"),
    second: getPart("second"),
  };
};

export const formatDateTime = (iso?: string): string => {
  if (!iso) return "-";
  const { year, month, day, hour, minute, second } = toDateParts(iso);
  return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
};

export const formatDate = (iso?: string): string => {
  if (!iso) return "-";
  const { year, month, day } = toDateParts(iso);
  return `${year}/${month}/${day}`;
};

export const formatDateInput = (iso?: string): string => {
  if (!iso) return "";
  return iso.slice(0, 10);
};

export const toCsv = (headers: string[], rows: Array<Array<string | number | undefined>>): string => {
  const escapeCell = (cell: string | number | undefined): string => {
    const raw = cell === undefined ? "" : String(cell);
    const escaped = raw.replaceAll('"', '""');
    return `"${escaped}"`;
  };

  return [headers.map(escapeCell).join(","), ...rows.map((row) => row.map(escapeCell).join(","))].join("\n");
};

export const downloadTextFile = (filename: string, text: string): void => {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
};

/**
 * 获取本周（周一到周日）的起止日期（YYYY-MM-DD）。
 */
export const getWeekRange = (anchor: Date = new Date()): { start: string; end: string } => {
  const d = new Date(anchor);
  const day = d.getDay() || 7; // Sunday=0 → 7
  const monday = new Date(d);
  monday.setDate(d.getDate() - (day - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
};

/**
 * 获取本月的起止日期（YYYY-MM-DD）。
 */
export const getMonthRange = (anchor: Date = new Date()): { start: string; end: string } => {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  const start = new Date(y, m, 1).toISOString().slice(0, 10);
  const end = new Date(y, m + 1, 0).toISOString().slice(0, 10);
  return { start, end };
};

/**
 * 从 ISO 日期字符串（YYYY-MM-DD）解析月份，格式 "YYYY年M月"。
 */
export const formatYearMonth = (iso?: string): string => {
  if (!iso || iso.length < 7) return "-";
  const y = iso.slice(0, 4);
  const m = Number.parseInt(iso.slice(5, 7), 10);
  return `${y}年${m}月`;
};

/**
 * 给定某一天（YYYY-MM-DD），返回它是本月第几周（1-5）。
 * 简单按"从本月1号开始每 7 天一周"计算。
 */
export const getWeekOfMonth = (iso?: string): number => {
  if (!iso || iso.length < 10) return 0;
  const d = new Date(iso);
  const day = d.getDate();
  return Math.ceil(day / 7);
};

/**
 * 给定两个 YYYY-MM-DD，计算天数差（b - a），可空。
 */
export const diffDays = (a?: string, b?: string): number | null => {
  if (!a || !b) return null;
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return null;
  const ms = db.getTime() - da.getTime();
  return Math.round(ms / 86_400_000);
};
