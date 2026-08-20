import { describe, expect, it } from "vitest";

import {
  buildGanttDependencyLinks,
  buildGanttRows,
  findGanttCriticalTaskIds,
  resolveGanttCriticalTaskIds,
  getGanttDateRange,
} from "@/lib/gantt";
import type { ProjectGanttTask } from "@/domain/models";

const baseTask = (overrides: Partial<ProjectGanttTask>): ProjectGanttTask => ({
  id: "task-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  projectId: "project-1",
  parentId: null,
  taskCode: "Task1",
  taskCategory: "设计",
  taskName: "方案设计",
  taskDescription: "",
  startDate: "2026-06-01",
  durationDays: 10,
  actualStartDate: "",
  actualEndDate: "",
  progress: 0,
  predecessorTask: "",
  remark: "",
  sortOrder: 1,
  project: undefined,
  ...overrides,
});

describe("gantt helpers", () => {
  it("calculates task end date from start date and duration days", () => {
    const [row] = buildGanttRows([baseTask({ startDate: "2026-06-01", durationDays: 10 })]);

    expect(row.endDate).toBe("2026-06-10");
    expect(row.durationDays).toBe(10);
  });

  it("uses the explicit calendar finish for a working-day task bar", () => {
    const [row] = buildGanttRows([baseTask({
      startDate: "2026-08-17",
      finishDate: "2026-09-01",
      durationDays: 12,
    })], { coordinateMode: "ABSOLUTE" });

    expect(row.endDate).toBe("2026-09-01");
    expect(row.spanDays).toBe(16);
    expect(row.timelineEndDays).toBe(16);
    expect(getGanttDateRange([row], { coordinateMode: "ABSOLUTE" })).toEqual({
      startDate: "2026-08-17",
      endDate: "2026-09-01",
      totalDays: 16,
    });
  });

  it("keeps unscheduled tasks in the grid without giving them a task bar", () => {
    const [row] = buildGanttRows([baseTask({ durationDays: 0, finishDate: "" })]);

    expect(row.endDate).toBe("2026-06-01");
    expect(row.spanDays).toBe(0);
    expect(row.widthPercent).toBe(0);
  });

  it("keeps WBS rows visible before any task has been scheduled", () => {
    const rows = buildGanttRows([
      baseTask({ id: "task-1", taskName: "未排期父任务", startDate: "", finishDate: "", durationDays: 0 }),
      baseTask({ id: "task-2", taskName: "未排期子任务", startDate: "", finishDate: "", durationDays: 0 }),
    ]);

    expect(getGanttDateRange(rows)).toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.taskName)).toEqual(["未排期父任务", "未排期子任务"]);
    expect(rows.every((row) => row.spanDays === 0 && row.endDate === "")).toBe(true);
  });

  it("builds proportional timeline offsets for multiple tasks", () => {
    const rows = buildGanttRows([
      baseTask({ id: "task-1", startDate: "2026-06-01", durationDays: 5 }),
      baseTask({ id: "task-2", startDate: "2026-06-06", durationDays: 5 }),
    ]);

    expect(rows[0].leftPercent).toBe(0);
    expect(rows[0].widthPercent).toBe(50);
    expect(rows[1].leftPercent).toBe(50);
    expect(rows[1].widthPercent).toBe(50);
  });

  it("uses relative offsets as abstract workday coordinates", () => {
    const rows = buildGanttRows([
      baseTask({ id: "task-1", startDate: "", durationDays: 3, relativeStartOffsetDays: 0, relativeFinishOffsetDays: 2 }),
      baseTask({ id: "task-2", startDate: "", durationDays: 2, relativeStartOffsetDays: 5, relativeFinishOffsetDays: 6, predecessorTaskIds: ["task-1"] }),
    ]);

    expect(getGanttDateRange(rows)).toBeNull();
    expect(rows[0]).toMatchObject({ startDisplayLabel: "T0", finishDisplayLabel: "T0+2", timelineStartDays: 0, timelineEndDays: 3, spanDays: 3 });
    expect(rows[1]).toMatchObject({ startDisplayLabel: "T0+5", finishDisplayLabel: "T0+6", timelineStartDays: 5, timelineEndDays: 7, spanDays: 2 });
    expect(buildGanttDependencyLinks(rows)).toEqual([
      { predecessorId: "task-1", successorId: "task-2", predecessorName: "方案设计", successorName: "方案设计" },
    ]);
  });

  it("keeps unresolved T0 schedules relative even when an old calendar date remains", () => {
    const rows = buildGanttRows([
      baseTask({
        id: "task-1",
        startDate: "2026-08-01",
        finishDate: "2026-08-03",
        durationDays: 3,
        relativeStartOffsetDays: 2,
        relativeFinishOffsetDays: 4,
      }),
      baseTask({
        id: "task-2",
        startDate: "",
        finishDate: "",
        durationDays: 2,
        relativeStartOffsetDays: 5,
        relativeFinishOffsetDays: 6,
      }),
    ]);

    expect(getGanttDateRange(rows)).toBeNull();
    expect(rows[0]).toMatchObject({
      startDisplayLabel: "T0+2",
      finishDisplayLabel: "T0+4",
      timelineStartDays: 2,
      timelineEndDays: 5,
    });
  });

  it("keeps a concrete-T0 project entirely on calendar dates when legacy offsets remain", () => {
    const tasks = [
      baseTask({
        id: "task-1",
        startDate: "2026-08-14",
        finishDate: "2026-08-16",
        durationDays: 3,
        relativeStartOffsetDays: 0,
        relativeFinishOffsetDays: 2,
      }),
    ];

    expect(getGanttDateRange(tasks, { coordinateMode: "ABSOLUTE" })).toEqual({
      startDate: "2026-08-14",
      endDate: "2026-08-16",
      totalDays: 3,
    });
    expect(buildGanttRows(tasks, { coordinateMode: "ABSOLUTE" })[0]).toMatchObject({
      startDisplayLabel: "2026-08-14",
      finishDisplayLabel: "2026-08-16",
      timelineStartDays: 0,
      spanDays: 3,
    });
  });

  it("returns the visible date range for all gantt tasks", () => {
    const range = getGanttDateRange([
      baseTask({ id: "task-1", startDate: "2026-06-10", durationDays: 3 }),
      baseTask({ id: "task-2", startDate: "2026-06-01", durationDays: 6 }),
    ]);

    expect(range).toEqual({ startDate: "2026-06-01", endDate: "2026-06-12", totalDays: 12 });
  });

  it("builds dependency links from predecessor task names", () => {
    const links = buildGanttDependencyLinks([
      baseTask({ id: "task-1", taskName: "需求", predecessorTask: "" }),
      baseTask({ id: "task-2", taskName: "设计", predecessorTask: "需求" }),
      baseTask({ id: "task-3", taskName: "开发", predecessorTask: "需求，设计" }),
    ]);

    expect(links).toEqual([
      { predecessorId: "task-1", successorId: "task-2", predecessorName: "需求", successorName: "设计" },
      { predecessorId: "task-1", successorId: "task-3", predecessorName: "需求", successorName: "开发" },
      { predecessorId: "task-2", successorId: "task-3", predecessorName: "设计", successorName: "开发" },
    ]);
  });

  it("marks the longest dependency chain as critical", () => {
    const criticalIds = findGanttCriticalTaskIds([
      baseTask({ id: "task-1", taskName: "需求", durationDays: 2, predecessorTask: "" }),
      baseTask({ id: "task-2", taskName: "设计", durationDays: 8, predecessorTask: "需求" }),
      baseTask({ id: "task-3", taskName: "开发", durationDays: 2, predecessorTask: "需求" }),
      baseTask({ id: "task-4", taskName: "测试", durationDays: 3, predecessorTask: "设计，开发" }),
    ]);

    expect([...criticalIds]).toEqual(["task-4", "task-2", "task-1"]);
  });

  it("never exposes summary rows as critical work", () => {
    const tasks = [
      baseTask({ id: "summary", taskCode: "Task1", taskName: "父任务", durationDays: 10, totalFloatMinutes: 0 }),
      baseTask({ id: "leaf", parentId: "summary", taskCode: "Task1.1", taskName: "末级任务", durationDays: 10, totalFloatMinutes: 0 }),
      baseTask({ id: "standalone", taskCode: "Task2.1", taskName: "没有子任务的任务", durationDays: 1, totalFloatMinutes: 10 }),
    ];

    expect([...findGanttCriticalTaskIds(tasks)]).toEqual(["leaf"]);
    expect(buildGanttRows(tasks).filter((row) => row.isCritical).map((row) => row.id)).toEqual(["leaf"]);
  });

  it("removes completed leaf tasks from the active critical path", () => {
    const tasks = [
      baseTask({ id: "done", taskName: "已完成", durationDays: 5, progress: 100, totalFloatMinutes: 0 }),
      baseTask({ id: "active", taskName: "进行中", durationDays: 5, progress: 50, totalFloatMinutes: 0 }),
    ];

    expect([...findGanttCriticalTaskIds(tasks)]).toEqual(["active"]);
    expect(buildGanttRows(tasks).filter((row) => row.isCritical).map((row) => row.id)).toEqual(["active"]);
  });

  it("uses persisted CPM status instead of a local longest-chain fallback", () => {
    const tasks = [
      baseTask({ id: "critical", taskName: "服务端关键任务", durationDays: 1, totalFloatMinutes: 0, scheduleStatus: "CRITICAL", scheduleCalculatedAt: "2026-08-18T00:00:00.000Z" }),
      baseTask({ id: "conflict", taskName: "负浮动冲突", durationDays: 20, scheduleStatus: "NEGATIVE_FLOAT", scheduleCalculatedAt: "2026-08-18T00:00:00.000Z" }),
    ];

    expect([...resolveGanttCriticalTaskIds(tasks)]).toEqual(["critical"]);
    expect(buildGanttRows(tasks).filter((row) => row.isCritical).map((row) => row.id)).toEqual(["critical"]);
  });
});
