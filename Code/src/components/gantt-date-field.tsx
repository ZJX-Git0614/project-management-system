"use client";

import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { CalendarDays } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  areGanttDatePartsEmpty,
  buildGanttDate,
  normalizeEditedGanttYear,
  splitGanttDate,
  type GanttDateParts,
} from "@/lib/gantt-date-input";
import { cn } from "@/lib/utils";

interface GanttDateFieldProps {
  value: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Render a compact value instead of retaining the segmented editor. */
  readOnly?: boolean;
  /** Display-only half-day marker used when the task date is not editable. */
  slot?: "AM" | "PM";
  min?: string;
  required?: boolean;
  displayValue?: string;
}

const SEGMENT_CLASS = "!h-5 !min-h-0 !border-0 !bg-transparent !p-0 text-center font-mono text-[10px] tabular-nums !shadow-none !ring-0";

export const GanttDateField = ({
  value,
  onChange,
  onCommit,
  ariaLabel,
  disabled = false,
  readOnly = false,
  slot = "AM",
  min,
  required = false,
  displayValue,
}: GanttDateFieldProps) => {
  const currentYear = new Date().getFullYear();
  const [parts, setParts] = useState<GanttDateParts>(() => splitGanttDate(value));
  const yearRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setParts(splitGanttDate(value));
  }, [value]);

  const withinRange = (date: string) => !date || !min || date >= min;

  const updatePart = (key: keyof GanttDateParts, rawValue: string, maxLength: number) => {
    const nextParts = {
      ...parts,
      [key]: rawValue.replace(/\D/g, "").slice(0, maxLength),
    };
    setParts(nextParts);
    if (areGanttDatePartsEmpty(nextParts)) {
      onChange("");
      return;
    }
    const nextValue = buildGanttDate(nextParts, { currentYear });
    if (nextValue && withinRange(nextValue)) onChange(nextValue);
  };

  const ensureCurrentYear = () => {
    if (parts.year) return;
    setParts((current) => ({ ...current, year: String(currentYear) }));
  };

  const updateYear = (rawValue: string) => {
    updatePart("year", normalizeEditedGanttYear(parts.year, rawValue, currentYear), 4);
  };

  const handleYearFocus = () => {
    ensureCurrentYear();
    window.requestAnimationFrame(() => {
      const input = yearRef.current;
      if (input?.value.length === 4) input.setSelectionRange(2, 4);
    });
  };

  const resetParts = () => setParts(splitGanttDate(value));

  const commitParts = () => {
    const nextValue = buildGanttDate(parts, { allowShortSegments: true, currentYear });
    if (nextValue === null || (required && !nextValue) || !withinRange(nextValue)) {
      resetParts();
      return;
    }
    setParts(splitGanttDate(nextValue));
    // Moving focus through an unchanged date field must not trigger a schedule
    // recalculation. This is especially important for AUTO tasks, where an
    // unrelated field edit can otherwise recompute the planned finish date.
    if (nextValue === value) return;
    onChange(nextValue);
    onCommit(nextValue);
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget as Node)) return;
    commitParts();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      resetParts();
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  };

  const openPicker = () => {
    const picker = pickerRef.current;
    if (!picker) return;
    try {
      picker.showPicker();
    } catch {
      picker.click();
    }
  };

  if (readOnly) {
    const dateValue = displayValue || value || "--";
    const slotLabel = slot === "PM" ? "\u2193" : "\u2191";
    const titleValue = value ? `${dateValue} ${slotLabel}` : dateValue;
    return (
      <output
        className="gantt-date-display"
        title={titleValue}
        aria-label={ariaLabel}
      >
        <span className="gantt-date-display-value">{dateValue}</span>
        {value && <span className="gantt-date-display-slot" aria-hidden="true">{slotLabel}</span>}
      </output>
    );
  }

  return (
    <div
      className={cn(
        "relative flex h-6 min-w-0 items-center gap-0.5 rounded px-1 transition-colors",
        "border border-transparent bg-transparent group-hover:bg-muted/10 hover:border-border/50",
        "focus-within:border-primary/50 focus-within:bg-background focus-within:ring-1 focus-within:ring-primary/20",
        disabled && "pointer-events-none opacity-50",
      )}
      onBlur={handleBlur}
      aria-label={ariaLabel}
    >
      <Input
        ref={yearRef}
        value={parts.year}
        onChange={(event) => updateYear(event.target.value)}
        onFocus={handleYearFocus}
        onKeyDown={handleKeyDown}
        inputMode="numeric"
        maxLength={4}
        placeholder={String(currentYear)}
        className={cn(SEGMENT_CLASS, "!w-[30px]")}
        disabled={disabled}
        aria-label={`${ariaLabel}年份`}
      />
      <span className="text-[9px] text-muted-foreground">-</span>
      <Input
        value={parts.month}
        onChange={(event) => updatePart("month", event.target.value, 2)}
        onFocus={ensureCurrentYear}
        onKeyDown={handleKeyDown}
        inputMode="numeric"
        maxLength={2}
        placeholder="月"
        className={cn(SEGMENT_CLASS, "!w-[16px]")}
        disabled={disabled}
        aria-label={`${ariaLabel}月份`}
      />
      <span className="text-[9px] text-muted-foreground">-</span>
      <Input
        value={parts.day}
        onChange={(event) => updatePart("day", event.target.value, 2)}
        onFocus={ensureCurrentYear}
        onKeyDown={handleKeyDown}
        inputMode="numeric"
        maxLength={2}
        placeholder="日"
        className={cn(SEGMENT_CLASS, "!w-[16px]")}
        disabled={disabled}
        aria-label={`${ariaLabel}日期`}
      />
      <button
        type="button"
        onClick={openPicker}
        className="ml-auto inline-flex !h-5 !min-h-0 !w-5 shrink-0 items-center justify-center !border-0 !bg-transparent !p-0 text-muted-foreground transition-colors hover:!bg-muted hover:text-foreground"
        disabled={disabled}
        title={`选择${ariaLabel}`}
        aria-label={`选择${ariaLabel}`}
      >
        <CalendarDays className="!size-3" />
      </button>
      <input
        ref={pickerRef}
        type="date"
        value={value}
        min={min}
        onChange={(event) => {
          const nextValue = event.target.value;
          if (required && !nextValue) {
            resetParts();
            return;
          }
          setParts(splitGanttDate(nextValue));
          onChange(nextValue);
          onCommit(nextValue);
        }}
        className="pointer-events-none absolute h-px w-px opacity-0"
        tabIndex={-1}
        disabled={disabled}
        aria-hidden="true"
      />
    </div>
  );
};
