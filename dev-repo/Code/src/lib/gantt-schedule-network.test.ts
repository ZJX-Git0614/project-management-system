import { describe, expect, it } from "vitest";

import { buildGanttLeafScheduleNetwork } from "@/lib/gantt-schedule-network";

type Task = {
  id: string;
  projectId: string;
  parentId: string | null;
  predecessorDependencies: Array<{ predecessorTaskId: string; type?: number }>;
};

const task = (
  id: string,
  parentId: string | null = null,
  predecessorTaskIds: string[] = [],
): Task => ({
  id,
  projectId: "project-1",
  parentId,
  predecessorDependencies: predecessorTaskIds.map((predecessorTaskId) => ({ predecessorTaskId, type: 1 })),
});

describe("buildGanttLeafScheduleNetwork", () => {
  it("将父任务 FS 关系展开为前置全部叶子到后置入口叶子的约束", () => {
    const result = buildGanttLeafScheduleNetwork([
      task("parent-a"),
      task("a-1", "parent-a"),
      task("a-2", "parent-a"),
      task("parent-b", null, ["parent-a"]),
      task("b-1", "parent-b"),
      task("b-2", "parent-b", ["b-1"]),
    ]);
    const byId = new Map(result.tasks.map((item) => [item.id, item]));

    expect(byId.get("parent-b")?.predecessorDependencies).toEqual([]);
    expect(byId.get("b-1")?.predecessorDependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ predecessorTaskId: "a-1" }),
      expect.objectContaining({ predecessorTaskId: "a-2" }),
    ]));
    expect(byId.get("b-2")?.predecessorDependencies).toEqual([
      expect.objectContaining({ predecessorTaskId: "b-1" }),
    ]);
    expect(result.entryLeafIdsBySummaryId.get("parent-b")).toEqual(["b-1"]);
  });

  it("保留无效引用供统一校验，不会在网络展开时静默删除", () => {
    const result = buildGanttLeafScheduleNetwork([
      task("parent"),
      task("leaf", "parent", ["missing-task"]),
    ]);

    expect(result.tasks.find((item) => item.id === "leaf")?.predecessorDependencies).toEqual([
      expect.objectContaining({ predecessorTaskId: "missing-task" }),
    ]);
  });

  it("不同项目即使错误复用父级标识也不会组成同一棵 WBS 树", () => {
    const result = buildGanttLeafScheduleNetwork([
      task("parent"),
      { ...task("external-child", "parent"), projectId: "project-2" },
    ]);

    expect(result.leafTaskIds).toEqual(["parent", "external-child"]);
  });
});
