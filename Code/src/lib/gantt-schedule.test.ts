import { describe, expect, it } from "vitest";

import { scheduleGanttTasks } from "@/lib/gantt-schedule";

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
});
