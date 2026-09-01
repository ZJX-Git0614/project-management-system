import { describe, expect, it } from "vitest";

import {
  deriveBackwardGanttDates,
  deriveDatesFixedDuration,
  deriveForwardGanttDates,
  deriveGanttPriority,
  ganttSchedulePriorityFor,
  findGanttHardBoundaryConflicts,
  normalizeGanttCompletion,
  normalizeGanttScheduleMode,
  resolveGanttTaskPlan,
  validateFsDependencies,
} from "@/lib/gantt-planning-rules";

describe("gantt planning rules", () => {
  it("normalizes legacy modes without rescheduling historical plans", () => {
    expect(normalizeGanttScheduleMode("MANUAL")).toBe("DATES_FIXED");
    expect(normalizeGanttScheduleMode("FIXED")).toBe("DATES_FIXED");
    expect(normalizeGanttScheduleMode("DURATION_FORWARD")).toBe("DURATION_FORWARD");
  });

  it("calculates forward and backward half-day schedules", () => {
    expect(deriveForwardGanttDates({
      startDate: "2026-08-10",
      startSlot: "AM",
      durationDays: 1.5,
      mode: "CALENDAR_DAYS",
    })).toMatchObject({ finishDate: "2026-08-11", finishSlot: "AM" });
    expect(deriveBackwardGanttDates({
      finishDate: "2026-08-11",
      finishSlot: "PM",
      durationDays: 1.5,
      mode: "CALENDAR_DAYS",
    })).toMatchObject({ startDate: "2026-08-10", startSlot: "PM" });
  });

  it("skips statutory non-working dates when calculating half-day slots", () => {
    expect(deriveForwardGanttDates({
      startDate: "2026-02-14",
      startSlot: "PM",
      durationDays: 1,
      mode: "WORKING_DAYS",
    })).toMatchObject({ finishDate: "2026-02-24", finishSlot: "AM" });
  });

  it("derives duration from fixed dates", () => {
    expect(deriveDatesFixedDuration({
      startDate: "2026-08-10",
      startSlot: "AM",
      finishDate: "2026-08-11",
      finishSlot: "PM",
      mode: "CALENDAR_DAYS",
    }).durationDays).toBe(2);
  });

  it("keeps automatic tasks unscheduled without an explicit anchor", () => {
    expect(resolveGanttTaskPlan({ taskMode: "AUTO", durationDays: 2, mode: "CALENDAR_DAYS" })).toMatchObject({
      startDate: "",
      finishDate: "",
      durationDays: 2,
    });
    expect(resolveGanttTaskPlan({
      taskMode: "DURATION_BACKWARD",
      finishDate: "2026-08-10",
      durationDays: 2,
      mode: "CALENDAR_DAYS",
    })).toMatchObject({ startDate: "2026-08-09", finishDate: "2026-08-10" });
  });

  it("derives readonly effective priority from critical path and dependencies", () => {
    expect(deriveGanttPriority({ userPriority: "LOW", isCritical: true })).toMatchObject({ effectivePriority: "HIGHEST", readOnly: true });
    expect(deriveGanttPriority({ userPriority: "LOW", hasSupportedPredecessor: true })).toMatchObject({ effectivePriority: "HIGH", readOnly: true });
    expect(deriveGanttPriority({ userPriority: "HIGH" })).toMatchObject({ effectivePriority: "HIGH", readOnly: false });
    expect(ganttSchedulePriorityFor("LOW")).toBeLessThan(ganttSchedulePriorityFor("MEDIUM"));
    expect(ganttSchedulePriorityFor("MEDIUM")).toBeLessThan(ganttSchedulePriorityFor("HIGH"));
    expect(ganttSchedulePriorityFor("HIGH")).toBeLessThan(ganttSchedulePriorityFor("HIGHEST"));
  });

  it("normalizes completion and prevents future actual finish dates", () => {
    expect(normalizeGanttCompletion({ progress: 100, today: "2026-08-10" })).toMatchObject({
      progress: 100,
      actualEndDate: "2026-08-10",
      actualFinishReadOnly: true,
    });
    expect(normalizeGanttCompletion({ progress: 90, actualEndDate: "2026-08-11", today: "2026-08-10" }).error).toBeTruthy();
    expect(normalizeGanttCompletion({ progress: 50, previousProgress: 100, actualEndDate: "2026-08-10", today: "2026-08-10" }).actualEndDate).toBe("");
  });

  it("detects hard parent boundary conflicts and rejects non-FS relationships", () => {
    expect(findGanttHardBoundaryConflicts([
      { id: "p", taskCode: "Task1", parentBoundaryMode: "LOCKED", startDate: "2026-08-10", finishDate: "2026-08-12" },
      { id: "c", parentId: "p", taskCode: "Task1.1", startDate: "2026-08-09", finishDate: "2026-08-12" },
    ])).toHaveLength(1);
    expect(validateFsDependencies([{ type: 1 }, { type: 0 }])).toHaveLength(1);
  });
});
