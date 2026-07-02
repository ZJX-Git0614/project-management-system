import { describe, expect, it } from "vitest";

import {
  assignMissingGanttTaskCodes,
  nextGanttTaskCode,
  orderGanttTasksByHierarchy,
  renumberGanttTaskCodes,
  type GanttTaskCodeSource,
} from "@/lib/gantt-task-codes";

const task = (overrides: Partial<GanttTaskCodeSource>): GanttTaskCodeSource => ({
  id: "task-1",
  parentId: null,
  taskCode: "",
  sortOrder: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("gantt task codes", () => {
  it("assigns WBS-style codes to root tasks and nested subtasks", () => {
    const tasks = assignMissingGanttTaskCodes([
      task({ id: "root", sortOrder: 1 }),
      task({ id: "child", parentId: "root", sortOrder: 1 }),
      task({ id: "grandchild", parentId: "child", sortOrder: 1 }),
    ]);

    expect(tasks.find((item) => item.id === "root")?.taskCode).toBe("Task1");
    expect(tasks.find((item) => item.id === "child")?.taskCode).toBe("Task1.1");
    expect(tasks.find((item) => item.id === "grandchild")?.taskCode).toBe("Task1.1.1");
  });

  it("generates the next child code below the selected parent", () => {
    const tasks = [
      task({ id: "root", taskCode: "Task1", sortOrder: 1 }),
      task({ id: "child-1", parentId: "root", taskCode: "Task1.1", sortOrder: 1 }),
      task({ id: "child-2", parentId: "root", taskCode: "Task1.2", sortOrder: 2 }),
    ];

    expect(nextGanttTaskCode(tasks, "root")).toBe("Task1.3");
  });

  it("renumbers siblings after their sort order changes", () => {
    const tasks = renumberGanttTaskCodes([
      task({ id: "first", taskCode: "Task1", sortOrder: 2 }),
      task({ id: "second", taskCode: "Task2", sortOrder: 1 }),
    ]);

    expect(tasks.find((item) => item.id === "second")?.taskCode).toBe("Task1");
    expect(tasks.find((item) => item.id === "first")?.taskCode).toBe("Task2");
  });

  it("orders children directly under their parent", () => {
    const ordered = orderGanttTasksByHierarchy([
      task({ id: "root-2", taskCode: "Task2", sortOrder: 2 }),
      task({ id: "child", parentId: "root-1", taskCode: "Task1.1", sortOrder: 1 }),
      task({ id: "root-1", taskCode: "Task1", sortOrder: 1 }),
    ]);

    expect(ordered.map((item) => item.id)).toEqual(["root-1", "child", "root-2"]);
  });
});
