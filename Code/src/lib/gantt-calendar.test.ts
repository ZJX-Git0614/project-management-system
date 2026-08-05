import { describe, expect, it } from "vitest";

import {
  calculateTaskDurationDays,
  calculateTaskFinishDate,
  estimatedHoursForDuration,
  nextTaskStartDate,
} from "@/lib/gantt-calendar";
import { scheduleGanttTasks } from "@/lib/gantt-schedule";

describe("gantt calendar", () => {
  it("calculates inclusive calendar days", () => {
    expect(calculateTaskFinishDate("2026-07-01", 10, "CALENDAR_DAYS")).toBe("2026-07-10");
    expect(nextTaskStartDate("2026-07-10", "CALENDAR_DAYS")).toBe("2026-07-11");
  });

  it("skips weekends for working days", () => {
    expect(calculateTaskFinishDate("2026-07-01", 10, "WORKING_DAYS")).toBe("2026-07-14");
    expect(nextTaskStartDate("2026-07-10", "WORKING_DAYS")).toBe("2026-07-13");
    expect(calculateTaskDurationDays("2026-07-01", "2026-07-14", "WORKING_DAYS")).toBe(10);
  });

  it("uses statutory holidays and adjusted workdays", () => {
    expect(calculateTaskFinishDate("2026-02-13", 2, "WORKING_DAYS")).toBe("2026-02-14");
    expect(nextTaskStartDate("2026-02-14", "WORKING_DAYS")).toBe("2026-02-24");
    expect(calculateTaskFinishDate("2026-02-27", 2, "WORKING_DAYS")).toBe("2026-02-28");
  });

  it("derives expected work at 7.5 hours per day", () => {
    expect(estimatedHoursForDuration(1)).toBe(7.5);
    expect(estimatedHoursForDuration(10)).toBe(75);
    expect(estimatedHoursForDuration(0.5)).toBe(3.75);
    expect(estimatedHoursForDuration(0)).toBe(0);
  });

  it("keeps half-day and unscheduled durations without inventing a full day", () => {
    expect(calculateTaskFinishDate("2026-07-01", 0.5, "CALENDAR_DAYS")).toBe("2026-07-01");
    expect(calculateTaskFinishDate("2026-07-01", 0, "CALENDAR_DAYS")).toBe("");

    const result = scheduleGanttTasks([
      { id: "half", startDate: "2026-07-01", durationDays: 0.5, taskMode: "AUTO" },
      { id: "empty", startDate: "2026-07-01", durationDays: 0, taskMode: "AUTO" },
    ], "CALENDAR_DAYS");

    expect(result[0]).toMatchObject({ finishDate: "2026-07-01", durationMinutes: 225, estimatedWorkHours: 3.75 });
    expect(result[1]).toMatchObject({ finishDate: "", durationMinutes: 0, estimatedWorkHours: 0 });
  });

  it("moves an automatic successor after its predecessor", () => {
    const result = scheduleGanttTasks([
      { id: "a", startDate: "2026-07-01", durationDays: 10, taskMode: "AUTO" },
      {
        id: "b",
        startDate: "2026-07-01",
        durationDays: 2,
        taskMode: "AUTO",
        predecessorDependencies: [{ predecessorTaskId: "a", type: 1, lag: 0 }],
      },
    ], "WORKING_DAYS");

    expect(result[0]).toMatchObject({ finishDate: "2026-07-14", durationMinutes: 4500, estimatedWorkHours: 75 });
    expect(result[1]).toMatchObject({ startDate: "2026-07-15", finishDate: "2026-07-16", estimatedWorkHours: 15 });
  });

  it.each([
    [0, "2026-07-02", "2026-07-03"],
    [1, "2026-07-06", "2026-07-07"],
    [2, "2026-06-30", "2026-07-01"],
    [3, "2026-07-01", "2026-07-02"],
  ])("supports Project dependency type %s", (type, expectedStart, expectedFinish) => {
    const result = scheduleGanttTasks([
      { id: "a", startDate: "2026-07-01", durationDays: 3, taskMode: "AUTO" },
      {
        id: "b",
        startDate: "2026-08-01",
        durationDays: 2,
        taskMode: "AUTO",
        predecessorDependencies: [{ predecessorTaskId: "a", type, lag: 0 }],
      },
    ], "WORKING_DAYS");

    expect(result[1]).toMatchObject({ startDate: expectedStart, finishDate: expectedFinish });
  });

  it("keeps a manually scheduled successor date", () => {
    const result = scheduleGanttTasks([
      { id: "a", startDate: "2026-07-01", durationDays: 10, taskMode: "AUTO" },
      {
        id: "b",
        startDate: "2026-07-02",
        durationDays: 2,
        taskMode: "MANUAL",
        predecessorDependencies: [{ predecessorTaskId: "a", type: 1, lag: 0 }],
      },
    ], "WORKING_DAYS");

    expect(result[1]).toMatchObject({ startDate: "2026-07-02", finishDate: "2026-07-03" });
  });

  it("keeps an accepted resource optimization after dependency recalculation", () => {
    const result = scheduleGanttTasks([
      { id: "a", startDate: "2026-07-01", durationDays: 3, taskMode: "AUTO" },
      {
        id: "b",
        startDate: "2026-07-10",
        durationDays: 2,
        taskMode: "AUTO",
        resourceNotBeforeDate: "2026-07-10",
        predecessorDependencies: [{ predecessorTaskId: "a", type: 1, lag: 0 }],
      },
    ], "WORKING_DAYS");

    expect(result[1]).toMatchObject({ startDate: "2026-07-10", finishDate: "2026-07-13" });
  });
});
