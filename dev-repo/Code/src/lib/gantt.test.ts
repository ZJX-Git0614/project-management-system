import { describe, expect, it } from "vitest";

import {
  buildGanttDependencyLinks,
  buildGanttRows,
  findGanttCriticalTaskIds,
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

  it("keeps unscheduled tasks in the grid without giving them a task bar", () => {
    const [row] = buildGanttRows([baseTask({ durationDays: 0, finishDate: "" })]);

    expect(row.endDate).toBe("2026-06-01");
    expect(row.spanDays).toBe(0);
    expect(row.widthPercent).toBe(0);
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
});
