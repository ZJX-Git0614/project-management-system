import { describe, expect, it } from "vitest";

import {
  ganttFloatCalendarSpanWithinDateBoundary,
  ganttFloatMinutesWithinDateBoundary,
  ganttFloatMinutesWithinRelativeBoundary,
} from "@/lib/gantt-float-display";
import { GANTT_MINUTES_PER_DAY } from "@/lib/gantt-cpm";

describe("gantt float display boundary", () => {
  it("removes positive float when a task already finishes at the project boundary", () => {
    expect(ganttFloatMinutesWithinDateBoundary(
      "2026-09-01",
      7 * GANTT_MINUTES_PER_DAY,
      "2026-09-01",
      "WORKING_DAYS",
    )).toBe(0);
  });

  it("caps calendar-day float at the remaining project window", () => {
    expect(ganttFloatMinutesWithinDateBoundary(
      "2026-08-27",
      7 * GANTT_MINUTES_PER_DAY,
      "2026-09-01",
      "CALENDAR_DAYS",
    )).toBe(5 * GANTT_MINUTES_PER_DAY);
  });

  it("does not draw float after a task that was already scheduled later than its CPM late finish", () => {
    expect(ganttFloatMinutesWithinDateBoundary(
      "2026-09-01",
      7 * GANTT_MINUTES_PER_DAY,
      "2026-09-01",
      "CALENDAR_DAYS",
      "2026-08-28",
    )).toBe(0);
  });

  it("does not render negative float and caps relative T0 float", () => {
    expect(ganttFloatMinutesWithinRelativeBoundary(
      12,
      -GANTT_MINUTES_PER_DAY,
      12,
    )).toBe(0);
    expect(ganttFloatMinutesWithinRelativeBoundary(
      4,
      7 * GANTT_MINUTES_PER_DAY,
      8,
    )).toBe(4 * GANTT_MINUTES_PER_DAY);
  });

  it("never renders a workday float line beyond the exact project finish date", () => {
    expect(ganttFloatCalendarSpanWithinDateBoundary(
      "2026-08-20",
      20 * GANTT_MINUTES_PER_DAY,
      "2026-09-01",
      "WORKING_DAYS",
    )).toBe(12);
  });
});
