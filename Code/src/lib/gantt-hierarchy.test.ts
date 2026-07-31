import { describe, expect, it } from "vitest";

import {
  changeGanttTaskHierarchy,
  synchronizeGanttTaskCategories,
  type GanttHierarchyTask,
} from "@/lib/gantt-hierarchy";
import { orderGanttTasksByHierarchy, renumberGanttTaskCodes } from "@/lib/gantt-task-codes";

const task = (
  id: string,
  parentId: string | null,
  sortOrder: number,
): GanttHierarchyTask & { taskCode: string } => ({
  id,
  parentId,
  sortOrder,
  taskCode: id,
  createdAt: `2026-01-${String(sortOrder).padStart(2, "0")}T00:00:00.000Z`,
});

describe("changeGanttTaskHierarchy", () => {
  it("indents a selected task below its previous sibling and carries its descendants", () => {
    const source = [
      task("first", null, 1),
      task("second", null, 2),
      task("child", "second", 1),
      task("third", null, 3),
    ];

    const result = changeGanttTaskHierarchy(source, ["second", "child"], "INDENT");
    const numbered = renumberGanttTaskCodes(result.tasks);

    expect(result.movedTaskIds).toEqual(["second"]);
    expect(numbered.find((item) => item.id === "second")).toMatchObject({ parentId: "first", taskCode: "Task1.1" });
    expect(numbered.find((item) => item.id === "child")).toMatchObject({ parentId: "second", taskCode: "Task1.1.1" });
    expect(numbered.find((item) => item.id === "third")).toMatchObject({ parentId: null, taskCode: "Task2" });
  });

  it("outdents a selected task and preserves the relative depth of its descendants", () => {
    const source = [
      task("root", null, 1),
      task("child", "root", 1),
      task("grandchild", "child", 1),
      task("sibling", "root", 2),
      task("last", null, 2),
    ];

    const result = changeGanttTaskHierarchy(source, ["child", "grandchild"], "OUTDENT");
    const numbered = renumberGanttTaskCodes(result.tasks);

    expect(result.movedTaskIds).toEqual(["child"]);
    expect(numbered.find((item) => item.id === "child")).toMatchObject({ parentId: null, taskCode: "Task2" });
    expect(numbered.find((item) => item.id === "grandchild")).toMatchObject({ parentId: "child", taskCode: "Task2.1" });
    expect(numbered.find((item) => item.id === "last")).toMatchObject({ parentId: null, taskCode: "Task3" });
  });

  it("keeps the visible preorder unchanged when the first child is outdented", () => {
    const source = [
      task("root", null, 1),
      task("first-child", "root", 1),
      task("second-child", "root", 2),
      task("last", null, 2),
    ];

    const before = orderGanttTasksByHierarchy(source).map((item) => item.id);
    const result = changeGanttTaskHierarchy(source, ["first-child"], "OUTDENT");
    const after = orderGanttTasksByHierarchy(result.tasks).map((item) => item.id);
    const numbered = renumberGanttTaskCodes(result.tasks);

    expect(after).toEqual(before);
    expect(numbered.find((item) => item.id === "first-child")).toMatchObject({ parentId: null, taskCode: "Task2" });
    expect(numbered.find((item) => item.id === "second-child")).toMatchObject({ parentId: "first-child", taskCode: "Task2.1" });
    expect(numbered.find((item) => item.id === "last")).toMatchObject({ parentId: null, taskCode: "Task3" });
  });

  it("outdents multiple sibling roots in their existing order", () => {
    const source = [
      task("root", null, 1),
      task("first", "root", 1),
      task("second", "root", 2),
      task("last", null, 2),
    ];

    const result = changeGanttTaskHierarchy(source, ["first", "second"], "OUTDENT");
    const numbered = renumberGanttTaskCodes(result.tasks);

    expect(result.movedTaskIds).toEqual(["first", "second"]);
    expect(numbered.filter((item) => item.parentId === null).map((item) => item.id)).toEqual(["root", "first", "second", "last"]);
  });

  it("does not indent the first task at a level", () => {
    const source = [task("first", null, 1), task("second", null, 2)];
    const result = changeGanttTaskHierarchy(source, ["first"], "INDENT");
    expect(result.movedTaskIds).toEqual([]);
    expect(result.changedTasks).toEqual([]);
  });

  it("does not make one selected root a child of another selected root", () => {
    const source = [task("first", null, 1), task("second", null, 2), task("third", null, 3)];
    const result = changeGanttTaskHierarchy(source, ["first", "second"], "INDENT");
    expect(result.movedTaskIds).toEqual([]);
  });

  it("keeps visible preorder unchanged when indenting a branch", () => {
    const source = [
      task("first", null, 1),
      task("first-child", "first", 1),
      task("second", null, 2),
      task("second-child", "second", 1),
      task("third", null, 3),
    ];

    const before = orderGanttTasksByHierarchy(source).map((item) => item.id);
    const result = changeGanttTaskHierarchy(source, ["second"], "INDENT");
    const after = orderGanttTasksByHierarchy(result.tasks).map((item) => item.id);

    expect(after).toEqual(before);
    expect(result.tasks.find((item) => item.id === "second")).toMatchObject({ parentId: "first" });
    expect(result.tasks.find((item) => item.id === "second-child")).toMatchObject({ parentId: "second" });
  });

  it("rebuilds only the moved branch's category path", () => {
    const source = [
      { ...task("root", null, 1), taskCategory: "设计", taskName: "设计阶段" },
      { ...task("feature", null, 2), taskCategory: "开发", taskName: "开发阶段" },
      { ...task("child", "feature", 1), taskCategory: "开发 / 接口", taskName: "接口实现" },
    ];

    const moved = changeGanttTaskHierarchy(source, ["feature"], "INDENT");
    const categorized = synchronizeGanttTaskCategories(moved.tasks, moved.movedTaskIds);

    expect(categorized.find((item) => item.id === "feature")).toMatchObject({ taskCategory: "设计 / 开发" });
    expect(categorized.find((item) => item.id === "child")).toMatchObject({ taskCategory: "设计 / 开发 / 接口" });
    expect(categorized.find((item) => item.id === "root")).toMatchObject({ taskCategory: "设计" });
  });
});
