import { describe, expect, it } from "vitest";

import { calculateGanttCpm, GANTT_MINUTES_PER_DAY } from "@/lib/gantt-cpm";

const task = (
  id: string,
  durationDays: number,
  predecessorTaskIds: string[] = [],
  overrides: Record<string, unknown> = {},
) => ({
  id,
  parentId: null,
  startDate: "2026-07-01",
  durationDays,
  durationMinutes: Math.round(durationDays * GANTT_MINUTES_PER_DAY),
  predecessorDependencies: predecessorTaskIds.map((predecessorTaskId) => ({ predecessorTaskId, type: 1, lag: 0 })),
  ...overrides,
});

describe("gantt CPM", () => {
  it("calculates total and free float across parallel branches", () => {
    const result = calculateGanttCpm([
      task("a", 2),
      task("b", 8, ["a"]),
      task("c", 2, ["a"]),
      task("d", 3, ["b", "c"]),
    ], "CALENDAR_DAYS");

    expect(result.metricsByTaskId.get("a")).toMatchObject({ totalFloatMinutes: 0, freeFloatMinutes: 0, scheduleStatus: "CRITICAL" });
    expect(result.metricsByTaskId.get("b")).toMatchObject({ totalFloatMinutes: 0, freeFloatMinutes: 0, scheduleStatus: "CRITICAL" });
    expect(result.metricsByTaskId.get("c")).toMatchObject({
      totalFloatMinutes: 6 * GANTT_MINUTES_PER_DAY,
      freeFloatMinutes: 6 * GANTT_MINUTES_PER_DAY,
      scheduleStatus: "NORMAL",
    });
    expect(result.metricsByTaskId.get("d")).toMatchObject({ totalFloatMinutes: 0, scheduleStatus: "CRITICAL" });
  });

  it("marks every branch when multiple critical paths have the same length", () => {
    const result = calculateGanttCpm([
      task("a", 2),
      task("b", 3, ["a"]),
      task("c", 3, ["a"]),
      task("d", 1, ["b", "c"]),
    ], "CALENDAR_DAYS");

    expect(["a", "b", "c", "d"].map((id) => result.metricsByTaskId.get(id)?.isCritical)).toEqual([true, true, true, true]);
  });

  it("supports SS, FF and SF dependency constraints", () => {
    const result = calculateGanttCpm([
      task("a", 4),
      task("ss", 2, [], { predecessorDependencies: [{ predecessorTaskId: "a", type: 3, lag: 0 }] }),
      task("ff", 2, [], { predecessorDependencies: [{ predecessorTaskId: "a", type: 0, lag: 0 }] }),
      task("sf", 2, [], { predecessorDependencies: [{ predecessorTaskId: "a", type: 2, lag: 0 }] }),
    ], "CALENDAR_DAYS");

    expect(result.metricsByTaskId.get("ss")?.earlyStartDate).toBe("2026-07-01");
    expect(result.metricsByTaskId.get("ff")?.earlyStartDate).toBe("2026-07-03");
    expect(result.metricsByTaskId.get("sf")?.earlyStartDate).toBe("2026-07-01");
  });

  it("exposes negative float when the required finish is earlier than the network finish", () => {
    const result = calculateGanttCpm([
      task("a", 3),
      task("b", 3, ["a"]),
    ], "CALENDAR_DAYS", "2026-07-05");

    expect(result.metricsByTaskId.get("a")).toMatchObject({
      totalFloatMinutes: -GANTT_MINUTES_PER_DAY,
      scheduleStatus: "NEGATIVE_FLOAT",
      isCritical: true,
    });
    expect(result.requiredFinishVarianceMinutes).toBe(-GANTT_MINUTES_PER_DAY);
  });

  it("aggregates summary metrics from leaf tasks without double-counting summary duration", () => {
    const result = calculateGanttCpm([
      task("summary", 10),
      task("a", 2, [], { parentId: "summary" }),
      task("b", 3, ["a"], { parentId: "summary" }),
    ], "CALENDAR_DAYS");

    expect(result.metricsByTaskId.get("summary")).toMatchObject({
      earlyStartDate: "2026-07-01",
      earlyFinishDate: "2026-07-05",
      totalFloatMinutes: 0,
      isCritical: true,
    });
  });

  it("keeps unscheduled zero-duration tasks separate from milestones", () => {
    const result = calculateGanttCpm([
      task("unscheduled", 0),
      task("milestone", 0, [], { isMilestone: true }),
    ], "CALENDAR_DAYS");

    expect(result.metricsByTaskId.get("unscheduled")?.scheduleStatus).toBe("UNSCHEDULED");
    expect(result.metricsByTaskId.get("milestone")).toMatchObject({ totalFloatMinutes: 0, scheduleStatus: "CRITICAL" });
  });

  it("uses the statutory working-day calendar for calculated dates", () => {
    const result = calculateGanttCpm([
      task("a", 2, [], { startDate: "2026-02-13" }),
      task("b", 1, ["a"], { startDate: "2026-02-24" }),
    ], "WORKING_DAYS");

    expect(result.metricsByTaskId.get("a")?.earlyFinishDate).toBe("2026-02-14");
    expect(result.metricsByTaskId.get("b")?.earlyStartDate).toBe("2026-02-24");
  });

  it("uses an actual late completion window for CPM without treating progress alone as schedule work", () => {
    const result = calculateGanttCpm([
      task("completed", 2, [], {
        startDate: "2026-07-01",
        actualStartDate: "2026-07-01",
        actualEndDate: "2026-07-05",
        progress: 100,
      }),
      task("successor", 1, ["completed"], { startDate: "2026-07-01" }),
    ], "CALENDAR_DAYS");

    expect(result.metricsByTaskId.get("completed")).toMatchObject({
      earlyFinishDate: "2026-07-05",
      isCritical: true,
    });
    expect(result.metricsByTaskId.get("successor")?.earlyStartDate).toBe("2026-07-06");
  });
});
