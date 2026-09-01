import { describe, expect, it } from "vitest";

import {
  relationIdsFromBody,
  serializeRisk,
  type RiskWithRelations,
} from "@/lib/project-associations";

const task = (id: string, sortOrder: number) => ({
  id,
  taskCode: `Task${sortOrder}`,
  taskName: `任务${sortOrder}`,
  parentId: null,
  sortOrder,
});

const matter = (id: string, sortOrder: number, tasks: ReturnType<typeof task>[]) => ({
  id,
  createdAt: new Date("2026-08-04T00:00:00.000Z"),
  updatedAt: new Date("2026-08-04T00:00:00.000Z"),
  projectId: "project-1",
  matterCode: `Matter${String(sortOrder).padStart(3, "0")}`,
  sortOrder,
  title: `事项${sortOrder}`,
  ganttTaskId: tasks[0]?.id ?? null,
  taskName: tasks[0]?.taskName ?? "",
  description: "",
  dueDate: "",
  status: "PENDING",
  owner: "张三",
  priority: "NORMAL",
  plannedStartDate: "",
  actualStartDate: "",
  plannedEndDate: "",
  actualEndDate: "",
  progress: 0,
  health: "UNKNOWN",
  issueAndAction: "",
  dependency: "",
  risk: "",
  riskStatus: "NONE",
  remark: "",
  ganttTask: tasks[0] ?? null,
  ganttTaskLinks: tasks.map((linkedTask) => ({
    weeklyItemId: id,
    ganttTaskId: linkedTask.id,
    createdAt: new Date("2026-08-04T00:00:00.000Z"),
    ganttTask: linkedTask,
  })),
});

describe("project association normalization", () => {
  it("prefers plural relation fields and removes duplicate or blank IDs", () => {
    expect(relationIdsFromBody(
      { ganttTaskIds: [" task-2 ", "task-1", "task-2", ""] },
      "ganttTaskIds",
      "ganttTaskId",
    )).toEqual(["task-2", "task-1"]);
    expect(relationIdsFromBody({ ganttTaskId: "task-1" }, "ganttTaskIds", "ganttTaskId"))
      .toEqual(["task-1"]);
    expect(relationIdsFromBody({}, "ganttTaskIds", "ganttTaskId")).toBeUndefined();
  });

  it("derives and deduplicates affected WBS tasks from linked matters", () => {
    const sharedTask = task("task-2", 2);
    const risk = {
      id: "risk-1",
      createdAt: new Date("2026-08-04T00:00:00.000Z"),
      updatedAt: new Date("2026-08-04T00:00:00.000Z"),
      projectId: "project-1",
      sortOrder: 1,
      riskCode: "Risk001",
      ganttTaskId: "legacy-task",
      weeklyItemId: "matter-2",
      riskName: "供应风险",
      linkedItemName: "",
      category: "进度",
      trigger: "",
      probability: "中",
      impact: "高",
      level: "高",
      response: "",
      owner: "李四",
      status: "识别中",
      targetDate: "",
      weeklyItem: null,
      weeklyItemLinks: [
        {
          riskItemId: "risk-1",
          weeklyItemId: "matter-2",
          createdAt: new Date("2026-08-04T00:00:00.000Z"),
          weeklyItem: matter("matter-2", 2, [sharedTask, task("task-3", 3)]),
        },
        {
          riskItemId: "risk-1",
          weeklyItemId: "matter-1",
          createdAt: new Date("2026-08-04T00:00:00.000Z"),
          weeklyItem: matter("matter-1", 1, [task("task-1", 1), sharedTask]),
        },
      ],
    } as unknown as RiskWithRelations;

    const serialized = serializeRisk(risk);

    expect(serialized.weeklyItemIds).toEqual(["matter-1", "matter-2"]);
    expect(serialized.linkedItems.map((item) => item.matterCode)).toEqual(["Matter001", "Matter002"]);
    expect(serialized.affectedTasks.map((item) => item.id)).toEqual(["task-1", "task-2", "task-3"]);
    expect(serialized.ganttTaskId).toBeNull();
  });
});
