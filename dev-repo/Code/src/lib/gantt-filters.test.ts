import { describe, expect, it } from "vitest";

import { filterGanttRowsWithAncestors, ganttFilterOptions } from "@/lib/gantt-filters";
import type { ProjectGanttTask } from "@/domain/models";

const task = (overrides: Partial<ProjectGanttTask>): ProjectGanttTask => ({
  id: "task-1",
  createdAt: "",
  updatedAt: "",
  projectId: "project-1",
  parentId: null,
  ownerMemberId: null,
  taskCode: "Task1",
  taskCategory: "软件",
  taskName: "任务",
  taskDescription: "描述",
  startDate: "2026-01-01",
  finishDate: "2026-01-02",
  durationDays: 2,
  actualStartDate: "",
  actualEndDate: "",
  progress: 0,
  predecessorTask: "",
  remark: "",
  sortOrder: 1,
  ...overrides,
});

describe("WBS Excel-style filters", () => {
  it("uses AND across columns and preserves only the matching task's ancestor path", () => {
    const rows = [
      task({ id: "root", taskName: "软件开发" }),
      task({ id: "branch-a", parentId: "root", taskName: "前端" }),
      task({ id: "leaf-a", parentId: "branch-a", taskName: "登录页", startDate: "2026-02-01" }),
      task({ id: "branch-b", parentId: "root", taskName: "后端" }),
      task({ id: "leaf-b", parentId: "branch-b", taskName: "登录接口", startDate: "2026-03-01" }),
    ];

    expect(filterGanttRowsWithAncestors(rows, {
      taskName: ["登录页"],
      startDate: ["2026-02-01"],
    }).map((item) => item.id)).toEqual(["root", "branch-a", "leaf-a"]);
  });

  it("uses OR within one column and exposes a single unassigned owner option", () => {
    const rows = [
      task({ id: "a", taskName: "A" }),
      task({ id: "b", taskName: "B" }),
      task({ id: "c", taskName: "C" }),
    ];

    expect(filterGanttRowsWithAncestors(rows, { taskName: ["A", "C"] }).map((item) => item.id)).toEqual(["a", "c"]);
    expect(ganttFilterOptions(rows, "owner")).toEqual(["未分配"]);
  });
});
