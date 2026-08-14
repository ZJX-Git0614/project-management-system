import { describe, expect, it } from "vitest";

import {
  fixedSuccessorTaskIdsBlockedByActualCompletion,
  scheduleGanttTasks,
} from "@/lib/gantt-schedule";

describe("scheduleGanttTasks", () => {
  it("back-schedules an undated automatic child from a locked parent finish", () => {
    const scheduled = scheduleGanttTasks([
      {
        id: "parent",
        startDate: "2026-02-01",
        finishDate: "2026-02-10",
        durationDays: 10,
        parentBoundaryMode: "LOCKED",
        taskMode: "MANUAL",
      },
      {
        id: "child",
        parentId: "parent",
        startDate: "",
        finishDate: "",
        durationDays: 2,
        taskMode: "AUTO",
      },
    ], "CALENDAR_DAYS");

    expect(scheduled.find((task) => task.id === "child")).toMatchObject({
      startDate: "2026-02-09",
      finishDate: "2026-02-10",
    });
  });

  it("uses the project target finish when an automatic task has no dependency or start date", () => {
    const scheduled = scheduleGanttTasks([{
      id: "root",
      startDate: "",
      finishDate: "",
      durationDays: 2,
      taskMode: "AUTO",
    }], "CALENDAR_DAYS", { expectedEndDate: "2026-02-10" });

    expect(scheduled[0]).toMatchObject({ startDate: "2026-02-09", finishDate: "2026-02-10" });
  });

  it("does not invent dates for a manual task without a start date", () => {
    const scheduled = scheduleGanttTasks([{
      id: "manual",
      startDate: "",
      finishDate: "",
      durationDays: 2,
      taskMode: "MANUAL",
    }], "CALENDAR_DAYS", { expectedEndDate: "2026-02-10" });

    expect(scheduled[0]).toMatchObject({ startDate: "", finishDate: "" });
  });

  it("uses the actual finish of a completed predecessor as the FS anchor", () => {
    const scheduled = scheduleGanttTasks([
      {
        id: "done",
        startDate: "2026-02-01",
        finishDate: "2026-02-02",
        actualEndDate: "2026-02-05",
        progress: 100,
        durationDays: 2,
        taskMode: "DATES_FIXED",
      },
      {
        id: "next",
        startDate: "",
        finishDate: "",
        durationDays: 1,
        taskMode: "AUTO",
        predecessorDependencies: [{ predecessorTaskId: "done", type: 1, lag: 0 }],
      },
    ], "CALENDAR_DAYS");

    expect(scheduled.find((task) => task.id === "next")).toMatchObject({
      startDate: "2026-02-06",
      finishDate: "2026-02-06",
    });
  });

  it("returns a date-fixed successor that an actual completion has made impossible", () => {
    const blocked = fixedSuccessorTaskIdsBlockedByActualCompletion([
      {
        id: "done",
        startDate: "2026-02-01",
        finishDate: "2026-02-02",
        actualEndDate: "2026-02-05",
        progress: 100,
        durationDays: 2,
        taskMode: "DATES_FIXED",
      },
      {
        id: "fixed-next",
        startDate: "2026-02-04",
        finishDate: "2026-02-04",
        durationDays: 1,
        progress: 0,
        taskMode: "DATES_FIXED",
        predecessorDependencies: [{ predecessorTaskId: "done", type: 1, lag: 0 }],
      },
    ], "CALENDAR_DAYS", ["done"]);

    expect(blocked).toEqual(["fixed-next"]);
  });

  it("keeps a feasible date-fixed successor unchanged", () => {
    const blocked = fixedSuccessorTaskIdsBlockedByActualCompletion([
      {
        id: "done",
        startDate: "2026-02-01",
        finishDate: "2026-02-02",
        actualEndDate: "2026-02-05",
        progress: 100,
        durationDays: 2,
        taskMode: "DATES_FIXED",
      },
      {
        id: "fixed-next",
        startDate: "2026-02-06",
        finishDate: "2026-02-06",
        durationDays: 1,
        progress: 0,
        taskMode: "DATES_FIXED",
        predecessorDependencies: [{ predecessorTaskId: "done", type: 1, lag: 0 }],
      },
    ], "CALENDAR_DAYS", ["done"]);

    expect(blocked).toEqual([]);
  });

  it("does not release a fixed successor for an unfinished actual update", () => {
    const blocked = fixedSuccessorTaskIdsBlockedByActualCompletion([
      {
        id: "in-progress",
        startDate: "2026-02-01",
        finishDate: "2026-02-05",
        actualEndDate: "",
        progress: 50,
        durationDays: 5,
        taskMode: "DATES_FIXED",
      },
      {
        id: "fixed-next",
        startDate: "2026-02-04",
        finishDate: "2026-02-04",
        durationDays: 1,
        progress: 0,
        taskMode: "DATES_FIXED",
        predecessorDependencies: [{ predecessorTaskId: "in-progress", type: 1, lag: 0 }],
      },
    ], "CALENDAR_DAYS", ["in-progress"]);

    expect(blocked).toEqual([]);
  });

  it("expands a parent dependency before checking an actual completion", () => {
    const blocked = fixedSuccessorTaskIdsBlockedByActualCompletion([
      {
        id: "parent-a",
        projectId: "project-1",
        parentId: null,
        startDate: "2026-02-01",
        finishDate: "2026-02-05",
        durationDays: 5,
        taskMode: "DATES_FIXED",
      },
      {
        id: "a-leaf",
        projectId: "project-1",
        parentId: "parent-a",
        startDate: "2026-02-01",
        finishDate: "2026-02-02",
        actualEndDate: "2026-02-05",
        progress: 100,
        durationDays: 2,
        taskMode: "DATES_FIXED",
      },
      {
        id: "parent-b",
        projectId: "project-1",
        parentId: null,
        startDate: "2026-02-04",
        finishDate: "2026-02-04",
        durationDays: 1,
        taskMode: "DATES_FIXED",
        predecessorDependencies: [{ predecessorTaskId: "parent-a", type: 1, lag: 0 }],
      },
      {
        id: "b-entry",
        projectId: "project-1",
        parentId: "parent-b",
        startDate: "2026-02-04",
        finishDate: "2026-02-04",
        durationDays: 1,
        progress: 0,
        taskMode: "DATES_FIXED",
      },
    ], "CALENDAR_DAYS", ["a-leaf"]);

    expect(blocked).toEqual(["b-entry"]);
  });

  it("releases every impossible date-fixed task along the affected FS chain", () => {
    const blocked = fixedSuccessorTaskIdsBlockedByActualCompletion([
      {
        id: "done",
        startDate: "2026-02-01",
        finishDate: "2026-02-02",
        actualEndDate: "2026-02-05",
        progress: 100,
        durationDays: 2,
        taskMode: "DATES_FIXED",
      },
      {
        id: "fixed-next",
        startDate: "2026-02-04",
        finishDate: "2026-02-05",
        durationDays: 2,
        progress: 0,
        taskMode: "DATES_FIXED",
        predecessorDependencies: [{ predecessorTaskId: "done", type: 1, lag: 0 }],
      },
      {
        id: "fixed-after-next",
        startDate: "2026-02-06",
        finishDate: "2026-02-06",
        durationDays: 1,
        progress: 0,
        taskMode: "DATES_FIXED",
        predecessorDependencies: [{ predecessorTaskId: "fixed-next", type: 1, lag: 0 }],
      },
      {
        id: "unrelated-invalid",
        startDate: "2026-02-01",
        finishDate: "2026-02-01",
        durationDays: 1,
        progress: 0,
        taskMode: "DATES_FIXED",
        predecessorDependencies: [{ predecessorTaskId: "fixed-after-next", type: 1, lag: 0 }],
      },
    ], "CALENDAR_DAYS", ["done"]);

    expect(blocked).toEqual(["fixed-next", "fixed-after-next", "unrelated-invalid"]);
  });

  it("does not release a fixed task outside the changed predecessor closure", () => {
    const blocked = fixedSuccessorTaskIdsBlockedByActualCompletion([
      {
        id: "done",
        startDate: "2026-02-01",
        finishDate: "2026-02-02",
        actualEndDate: "2026-02-05",
        progress: 100,
        durationDays: 2,
        taskMode: "DATES_FIXED",
      },
      {
        id: "other-predecessor",
        startDate: "2026-02-01",
        finishDate: "2026-02-05",
        durationDays: 5,
        taskMode: "DATES_FIXED",
      },
      {
        id: "unrelated-fixed",
        startDate: "2026-02-03",
        finishDate: "2026-02-03",
        durationDays: 1,
        progress: 0,
        taskMode: "DATES_FIXED",
        predecessorDependencies: [{ predecessorTaskId: "other-predecessor", type: 1, lag: 0 }],
      },
    ], "CALENDAR_DAYS", ["done"]);

    expect(blocked).toEqual([]);
  });
});
