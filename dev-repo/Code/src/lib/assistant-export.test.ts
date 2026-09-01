import { describe, expect, it } from "vitest";

import {
  assistantExportPlanPreservesRequest,
  buildGanttProgressReport,
  parseAssistantProjectExportIntent,
  selectGanttExportRows,
  selectWeeklyExportRows,
} from "@/lib/assistant-export";

describe("assistant project export", () => {
  it("preserves explicit task-depth and matter-priority filters", () => {
    expect(parseAssistantProjectExportIntent("帮我导出所有一级的甘特任务清单")).toEqual({
      exportType: "gantt",
      taskDepths: [1],
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
      taskDepths: [2],
      taskProgress: "INCOMPLETE",
    });
    expect(parseAssistantProjectExportIntent("导出紧急且已完成的事项")).toEqual({
      exportType: "weekly",
      weeklyPriority: "URGENT",
      weeklyStatus: "DONE",
    });
  });

  it("preserves every requested task level from lists and ranges", () => {
    expect(parseAssistantProjectExportIntent("只导出 1 2 3 级任务")).toEqual({
      exportType: "gantt",
      taskDepths: [1, 2, 3],
      taskProgress: undefined,
    });
    expect(parseAssistantProjectExportIntent("下载第一、第二和第三级甘特任务")).toEqual({
      exportType: "gantt",
      taskDepths: [1, 2, 3],
      taskProgress: undefined,
    });
    expect(parseAssistantProjectExportIntent("导出第 2 至 4 层任务")).toEqual({
      exportType: "gantt",
      taskDepths: [2, 3, 4],
      taskProgress: undefined,
    });
    expect(assistantExportPlanPreservesRequest(
      { exportType: "gantt", taskDepths: [1, 2, 3] },
      { exportType: "gantt", taskDepths: [1] },
    )).toBe(false);
    expect(assistantExportPlanPreservesRequest(
      { exportType: "gantt", taskDepths: [1, 2, 3] },
      { exportType: "gantt", taskDepths: [3, 1, 2] },
    )).toBe(true);
    expect(assistantExportPlanPreservesRequest(
      { exportType: "gantt", taskDepths: [1, 2, 3] },
      { exportType: "gantt", taskDepths: [1, 2, 3], taskProgress: "COMPLETED" },
    )).toBe(false);
  });

  it("preserves task category keywords and a requested progress report", () => {
    const request = parseAssistantProjectExportIntent("帮我导出所有的前端任务，并且对当前前端任务进度总结出一份报告");
    expect(request).toEqual({
      exportType: "gantt",
      taskDepths: undefined,
      taskProgress: undefined,
      taskCategoryKeywords: ["前端"],
      includeProgressReport: true,
    });
    expect(assistantExportPlanPreservesRequest(
      request!,
      { exportType: "gantt", taskCategoryKeywords: ["前端"], includeProgressReport: true },
    )).toBe(true);
    expect(assistantExportPlanPreservesRequest(
      request!,
      { exportType: "gantt", includeProgressReport: true },
    )).toBe(false);
  });

  it("preserves a requested budget visualization deliverable", () => {
    const request = parseAssistantProjectExportIntent("将项目预算管理整理成表并导出，而且需要数据可视化");

    expect(request).toEqual({
      exportType: "budget",
      includeVisualization: true,
    });
    expect(assistantExportPlanPreservesRequest(
      request!,
      { exportType: "budget" },
    )).toBe(false);
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
    expect(selectGanttExportRows(rows, { taskDepths: [1, 3] }).map((row) => row.id)).toEqual([
      "root-1",
      "grandchild",
      "root-2",
    ]);
  });

  it("filters category keywords and computes a report only from matching rows", () => {
    const rows = [
      { id: "frontend-1", parentId: null, taskCode: "Task1", sortOrder: 1, progress: 100, taskCategory: "前端开发", taskName: "登录页", finishDate: "2026-07-01" },
      { id: "frontend-2", parentId: null, taskCode: "Task2", sortOrder: 2, progress: 50, taskCategory: "前端开发 / 页面", taskName: "项目列表", finishDate: "2026-07-15" },
      { id: "backend-1", parentId: null, taskCode: "Task3", sortOrder: 3, progress: 0, taskCategory: "后端开发", taskName: "鉴权接口", finishDate: "2026-09-01" },
    ];
    const matched = selectGanttExportRows(rows, { taskCategoryKeywords: ["前端"] });
    expect(matched.map((row) => row.id)).toEqual(["frontend-1", "frontend-2"]);
    expect(buildGanttProgressReport(matched, "2026-08-02")).toMatchObject({
      total: 2,
      completed: 1,
      inProgress: 1,
      notStarted: 0,
      overdue: 1,
      averageProgress: 75,
    });
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
