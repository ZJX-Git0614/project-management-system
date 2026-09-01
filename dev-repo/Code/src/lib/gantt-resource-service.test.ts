import { describe, expect, it } from "vitest";

import {
  collectManualScheduleImpactTaskIds,
} from "@/lib/gantt-resource-service";
import type { ResourceSchedulingTask } from "@/lib/gantt-resource-schedule";

const task = (overrides: Partial<ResourceSchedulingTask> = {}): ResourceSchedulingTask => ({
  id: "task-a",
  projectId: "project-1",
  taskName: "任务 A",
  parentId: null,
  isLeaf: true,
  ownerKeys: [],
  startDate: "2026-08-01",
  finishDate: "2026-08-01",
  durationDays: 1,
  progress: 0,
  taskMode: "AUTO",
  sortOrder: 1,
  predecessorDependencies: [],
  isCurrentProject: true,
  ...overrides,
});

describe("collectManualScheduleImpactTaskIds", () => {
  it("uses the proposed dependency graph and includes both released and newly added predecessors", () => {
    const tasks = [
      task({ id: "old-predecessor", taskName: "旧紧前任务", sortOrder: 1 }),
      task({
        id: "new-predecessor",
        taskName: "新紧前任务",
        sortOrder: 2,
        predecessorDependencies: [{ predecessorTaskId: "old-predecessor" }],
      }),
      task({
        id: "target",
        taskName: "当前任务",
        sortOrder: 3,
        predecessorDependencies: [{ predecessorTaskId: "old-predecessor" }],
      }),
      task({
        id: "successor",
        taskName: "紧后任务",
        sortOrder: 4,
        predecessorDependencies: [{ predecessorTaskId: "target" }],
      }),
    ];

    const preview = collectManualScheduleImpactTaskIds(tasks, "target", {
      startDate: "2026-08-02",
      finishDate: "2026-08-02",
      durationDays: 1,
      taskMode: "DATES_FIXED",
      predecessorDependencies: [{ predecessorTaskId: "new-predecessor" }],
    });

    expect(preview.affectedTaskIds).toEqual([
      "old-predecessor",
      "new-predecessor",
      "target",
      "successor",
    ]);
    expect(preview.patchedTasks.find((item) => item.id === "target")?.predecessorDependencies).toEqual([
      { predecessorTaskId: "new-predecessor" },
    ]);
  });

  it("includes parent rollups, descendants and successor work when a parent boundary changes", () => {
    const tasks = [
      task({ id: "root", taskName: "父任务", isLeaf: false, sortOrder: 1 }),
      task({ id: "child", taskName: "子任务", parentId: "root", sortOrder: 2 }),
      task({
        id: "successor",
        taskName: "紧后任务",
        sortOrder: 3,
        predecessorDependencies: [{ predecessorTaskId: "child" }],
      }),
    ];

    const preview = collectManualScheduleImpactTaskIds(tasks, "root", {
      startDate: "2026-08-02",
      finishDate: "2026-08-08",
      durationDays: 7,
      taskMode: "DATES_FIXED",
      parentBoundaryMode: "TARGET",
    });

    expect(preview.affectedTaskIds).toEqual(["root", "child", "successor"]);
  });

  it("uses the proposed responsible person for resource-conflict preview", () => {
    const tasks = [
      task({
        id: "target",
        ownerKeys: ["account:owner-a"],
        ownerAssignments: [{ ownerKey: "account:owner-a", unitsPercent: 100 }],
        startDate: "2026-08-02",
        finishDate: "2026-08-03",
      }),
      task({
        id: "occupied",
        ownerKeys: ["account:owner-b"],
        ownerAssignments: [{ ownerKey: "account:owner-b", unitsPercent: 100 }],
        startDate: "2026-08-02",
        finishDate: "2026-08-03",
        taskMode: "DATES_FIXED",
        sortOrder: 2,
      }),
    ];

    const preview = collectManualScheduleImpactTaskIds(tasks, "target", {
      startDate: "2026-08-02",
      finishDate: "2026-08-03",
      durationDays: 2,
      taskMode: "AUTO",
      schedulePriority: 750,
      effortDriven: true,
      parallelizable: true,
      ownerAssignments: [{ ownerKey: "account:owner-b", unitsPercent: 100 }],
    });

    expect(preview.patchedTasks.find((item) => item.id === "target")).toMatchObject({
      ownerKeys: ["account:owner-b"],
      schedulePriority: 750,
      effortDriven: true,
      parallelizable: true,
    });
  });
});
