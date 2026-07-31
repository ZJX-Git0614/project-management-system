import { describe, expect, it } from "vitest";

import {
  parseAssistantProjectExportIntent,
  selectGanttExportRows,
  selectWeeklyExportRows,
} from "@/lib/assistant-export";

describe("assistant project export", () => {
  it("preserves explicit task-depth and matter-priority filters", () => {
    expect(parseAssistantProjectExportIntent("帮我导出所有一级的甘特任务清单")).toEqual({
      exportType: "gantt",
      taskDepth: 1,
      taskProgress: undefined,
    });
    expect(parseAssistantProjectExportIntent("只导出事项中为紧急的")).toEqual({
      exportType: "weekly",
      weeklyPriority: "URGENT",
      weeklyStatus: undefined,
    });
    expect(parseAssistantProjectExportIntent("下载进行中的高优先级事项")).toEqual({
      exportType: "weekly",
      weeklyPriority: "HIGH",
      weeklyStatus: "IN_PROGRESS",
    });
    expect(parseAssistantProjectExportIntent("只下载未完成的二级任务")).toEqual({
      exportType: "gantt",
      taskDepth: 2,
      taskProgress: "INCOMPLETE",
    });
    expect(parseAssistantProjectExportIntent("导出紧急且已完成的事项")).toEqual({
      exportType: "weekly",
      weeklyPriority: "URGENT",
      weeklyStatus: "DONE",
    });
  });

  it("orders tasks by the original parent-child hierarchy before filtering", () => {
    const rows = [
      { id: "child-2", parentId: "root-1", taskCode: "Task1.2", sortOrder: 2, progress: 20 },
      { id: "root-2", parentId: null, taskCode: "Task2", sortOrder: 2, progress: 0 },
      { id: "grandchild", parentId: "child-1", taskCode: "Task1.1.1", sortOrder: 1, progress: 100 },
      { id: "root-1", parentId: null, taskCode: "Task1", sortOrder: 1, progress: 0 },
      { id: "child-1", parentId: "root-1", taskCode: "Task1.1", sortOrder: 1, progress: 50 },
    ];

    expect(selectGanttExportRows(rows, {}).map((row) => row.id)).toEqual([
      "root-1",
      "child-1",
      "grandchild",
      "child-2",
      "root-2",
    ]);
    expect(selectGanttExportRows(rows, { taskDepth: 1 }).map((row) => row.id)).toEqual([
      "root-1",
      "root-2",
    ]);
  });

  it("filters matters by priority and status without changing their current order", () => {
    const rows = [
      { id: "m1", priority: "URGENT", status: "DONE", progress: 35 },
      { id: "m2", priority: "HIGH", status: "IN_PROGRESS", progress: 60 },
      { id: "m3", priority: "URGENT", status: "PENDING", progress: 100 },
    ];
    expect(selectWeeklyExportRows(rows, { weeklyPriority: "URGENT" }).map((row) => row.id)).toEqual(["m1", "m3"]);
    expect(selectWeeklyExportRows(rows, { weeklyPriority: "URGENT", weeklyStatus: "IN_PROGRESS" }).map((row) => row.id)).toEqual(["m1"]);
    expect(selectWeeklyExportRows(rows, { weeklyPriority: "URGENT", weeklyStatus: "DONE" }).map((row) => row.id)).toEqual(["m3"]);
  });
});
