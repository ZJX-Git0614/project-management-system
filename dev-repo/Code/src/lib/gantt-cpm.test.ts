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

  it("marks non-FS dependency constraints as invalid instead of calculating a different network", () => {
    const result = calculateGanttCpm([
      task("a", 4),
      task("ss", 2, [], { predecessorDependencies: [{ predecessorTaskId: "a", type: 3, lag: 0 }] }),
      task("ff", 2, [], { predecessorDependencies: [{ predecessorTaskId: "a", type: 0, lag: 0 }] }),
      task("sf", 2, [], { predecessorDependencies: [{ predecessorTaskId: "a", type: 2, lag: 0 }] }),
    ], "CALENDAR_DAYS");

    expect(result.metricsByTaskId.get("ss")).toMatchObject({ scheduleStatus: "INVALID_DEPENDENCY", earlyStartDate: "" });
    expect(result.metricsByTaskId.get("ff")).toMatchObject({ scheduleStatus: "INVALID_DEPENDENCY", earlyStartDate: "" });
    expect(result.metricsByTaskId.get("sf")).toMatchObject({ scheduleStatus: "INVALID_DEPENDENCY", earlyStartDate: "" });
  });

  it("keeps negative-float conflicts visible without rendering negative float values", () => {
    const result = calculateGanttCpm([
      task("a", 3),
      task("b", 3, ["a"]),
    ], "CALENDAR_DAYS", "2026-07-05");

    expect(result.metricsByTaskId.get("a")).toMatchObject({
      totalFloatMinutes: 0,
      freeFloatMinutes: 0,
      scheduleStatus: "NEGATIVE_FLOAT",
      isCritical: false,
    });
    const metrics = result.metricsByTaskId.get("a")!;
    expect(metrics.earlyStartDate <= metrics.lateStartDate).toBe(true);
    expect(metrics.earlyFinishDate <= metrics.lateFinishDate).toBe(true);
    expect(result.requiredFinishVarianceMinutes).toBe(-GANTT_MINUTES_PER_DAY);
  });

  it("aggregates summary metrics from leaf tasks without double-counting summary duration", () => {
    const result = calculateGanttCpm([
      task("summary", 10),
      task("a", 2, [], { parentId: "summary", ownerMemberIds: ["member-1"] }),
      task("b", 3, ["a"], { parentId: "summary", ownerMemberIds: ["member-1"] }),
    ], "CALENDAR_DAYS");

    expect(result.metricsByTaskId.get("summary")).toMatchObject({
      earlyStartDate: "2026-07-01",
      earlyFinishDate: "2026-07-05",
      totalFloatMinutes: 0,
      isCritical: false,
    });
  });

  it("does not mark summary nodes critical regardless of descendant owners", () => {
    const singleOwner = calculateGanttCpm([
      task("summary", 5, [], { ownerMemberIds: [] }),
      task("a", 2, [], { parentId: "summary", ownerMemberIds: ["member-1"] }),
      task("b", 3, ["a"], { parentId: "summary", ownerMemberIds: ["member-1"] }),
    ], "CALENDAR_DAYS");
    const parallelOwners = calculateGanttCpm([
      task("summary", 5, [], { ownerMemberIds: [] }),
      task("a", 2, [], { parentId: "summary", ownerMemberIds: ["member-1"] }),
      task("b", 3, ["a"], { parentId: "summary", ownerMemberIds: ["member-2"] }),
    ], "CALENDAR_DAYS");

    expect(singleOwner.metricsByTaskId.get("summary")?.isCritical).toBe(false);
    expect(parallelOwners.metricsByTaskId.get("summary")?.isCritical).toBe(false);
    expect(singleOwner.metricsByTaskId.get("summary")?.scheduleStatus).toBe("NEAR_CRITICAL");
    expect(parallelOwners.metricsByTaskId.get("summary")?.scheduleStatus).toBe("NEAR_CRITICAL");
  });

  it("keeps unscheduled zero-duration tasks separate from milestones", () => {
    const result = calculateGanttCpm([
      task("unscheduled", 0),
      task("milestone", 0, [], { isMilestone: true }),
    ], "CALENDAR_DAYS");

    expect(result.metricsByTaskId.get("unscheduled")?.scheduleStatus).toBe("UNSCHEDULED");
    expect(result.metricsByTaskId.get("milestone")).toMatchObject({ totalFloatMinutes: 0, scheduleStatus: "CRITICAL" });
  });

  it("anchors an undated executable task at the project origin instead of an ancient date", () => {
    const result = calculateGanttCpm([
      task("summary", 2, [], { startDate: "2026-07-01" }),
      task("leaf", 2, [], { parentId: "summary", startDate: "" }),
    ], "CALENDAR_DAYS");

    expect(result.metricsByTaskId.get("leaf")).toMatchObject({
      earlyStartDate: "2026-07-01",
      earlyFinishDate: "2026-07-02",
    });
    expect(result.metricsByTaskId.get("leaf")?.earlyStartDate).not.toMatch(/^16/);
  });

  it("uses the statutory working-day calendar for calculated dates", () => {
    const result = calculateGanttCpm([
      task("a", 2, [], { startDate: "2026-02-13" }),
      task("b", 1, ["a"], { startDate: "2026-02-24" }),
    ], "WORKING_DAYS");

    expect(result.metricsByTaskId.get("a")?.earlyFinishDate).toBe("2026-02-14");
    expect(result.metricsByTaskId.get("b")?.earlyStartDate).toBe("2026-02-24");
  });

  it("does not turn AUTO resource placement into a critical-path constraint", () => {
    const result = calculateGanttCpm([
      task("long", 8, [], { taskMode: "AUTO", startDate: "2026-07-01" }),
      task("delayed", 1, [], { taskMode: "AUTO", startDate: "2026-07-10" }),
      task("successor", 2, ["delayed"], { taskMode: "AUTO", startDate: "2026-07-11" }),
    ], "CALENDAR_DAYS");

    expect(result.metricsByTaskId.get("long")).toMatchObject({
      totalFloatMinutes: 0,
      isCritical: true,
    });
    expect(result.metricsByTaskId.get("delayed")).toMatchObject({
      totalFloatMinutes: 5 * GANTT_MINUTES_PER_DAY,
      isCritical: false,
    });
    expect(result.metricsByTaskId.get("successor")).toMatchObject({
      totalFloatMinutes: 5 * GANTT_MINUTES_PER_DAY,
      isCritical: false,
    });
  });

  it("keeps fixed task dates as CPM constraints", () => {
    const result = calculateGanttCpm([
      task("long", 8, [], { taskMode: "AUTO", startDate: "2026-07-01" }),
      task("fixed", 1, [], { taskMode: "DATES_FIXED", startDate: "2026-07-10" }),
      task("successor", 2, ["fixed"], { taskMode: "AUTO", startDate: "2026-07-11" }),
    ], "CALENDAR_DAYS");

    expect(result.metricsByTaskId.get("long")?.isCritical).toBe(false);
    expect(result.metricsByTaskId.get("fixed")).toMatchObject({
      totalFloatMinutes: 0,
      isCritical: true,
    });
    expect(result.metricsByTaskId.get("successor")).toMatchObject({
      totalFloatMinutes: 0,
      isCritical: true,
    });
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
      scheduleStatus: "NORMAL",
      isCritical: false,
    });
    expect(result.metricsByTaskId.get("successor")?.earlyStartDate).toBe("2026-07-06");
  });

  it("caps leaf late dates and float at the parent finish boundary", () => {
    const result = calculateGanttCpm([
      task("parent", 12, [], { startDate: "2026-08-17", finishDate: "2026-09-01" }),
      task("child-a", 2, [], { parentId: "parent", startDate: "2026-08-17" }),
      task("child-b", 2, ["child-a"], { parentId: "parent", startDate: "2026-08-19" }),
    ], "CALENDAR_DAYS");

    expect((result.metricsByTaskId.get("child-a")?.lateFinishDate ?? "") <= "2026-09-01").toBe(true);
    expect((result.metricsByTaskId.get("child-b")?.lateFinishDate ?? "") <= "2026-09-01").toBe(true);
    ["child-a", "child-b"].forEach((taskId) => {
      const metrics = result.metricsByTaskId.get(taskId);
      expect(metrics?.freeFloatMinutes).not.toBeNull();
      expect(metrics?.totalFloatMinutes).not.toBeNull();
      expect(metrics!.freeFloatMinutes!).toBeLessThanOrEqual(metrics!.totalFloatMinutes!);
    });
  });

  it("keeps persisted resource-levelled bars out of CPM float and criticality", () => {
    const result = calculateGanttCpm([
      task("parent", 12, [], {
        startDate: "2026-08-17",
        finishDate: "2026-09-01",
      }),
      task("early", 3, [], {
        parentId: "parent",
        taskMode: "AUTO",
        startDate: "2026-08-17",
        finishDate: "2026-08-19",
      }),
      task("late", 2, [], {
        parentId: "parent",
        taskMode: "AUTO",
        startDate: "2026-08-31",
        finishDate: "2026-09-01",
      }),
    ], "CALENDAR_DAYS");

    expect(result.calculatedFinishDate).toBe("2026-09-01");
    expect(result.metricsByTaskId.get("late")).toMatchObject({
      lateFinishDate: "2026-08-19",
      totalFloatMinutes: 450,
      freeFloatMinutes: 450,
      scheduleStatus: "NEAR_CRITICAL",
      isCritical: false,
    });
    expect(result.projectCriticalTaskIds).toEqual(new Set(["early"]));
  });

  it("expands a summary FS dependency to the successor summary entry leaf", () => {
    const result = calculateGanttCpm([
      task("parent-a", 2),
      task("a-1", 1, [], { parentId: "parent-a" }),
      task("a-2", 1, [], { parentId: "parent-a" }),
      task("parent-b", 2, ["parent-a"]),
      task("b-1", 1, [], { parentId: "parent-b" }),
      task("b-2", 1, ["b-1"], {
        parentId: "parent-b",
      }),
    ], "CALENDAR_DAYS");

    expect(result.metricsByTaskId.get("b-1")?.earlyStartDate).toBe("2026-07-02");
    expect(result.metricsByTaskId.get("b-2")?.earlyStartDate).toBe("2026-07-03");
  });
});
