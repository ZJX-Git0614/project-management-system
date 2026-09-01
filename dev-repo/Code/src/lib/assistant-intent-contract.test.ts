import { describe, expect, it } from "vitest";

import type { AssistantActionView } from "@/lib/assistant-actions";
import {
  buildAssistantCompletedTraceEvents,
  buildAssistantIntentContract,
  composeVerifiedAssistantActionAnswer,
  verifyAssistantIntentCompletion,
} from "@/lib/assistant-intent-contract";

const request = "帮我导出所有的前端任务，并且对当前前端任务进度总结出一份报告";

const action = (result: Record<string, unknown>): AssistantActionView => ({
  id: "action-1",
  toolId: "project.export",
  title: "导出任务进度",
  description: "导出前端任务并生成进度总结",
  riskLevel: "LOW",
  status: "SUCCEEDED",
  expiresAt: "2026-08-03T00:00:00.000Z",
  result,
});

const progressReport = {
  total: 12,
  completed: 4,
  inProgress: 6,
  notStarted: 2,
  overdue: 1,
  averageProgress: 55.5,
  categoryBreakdown: [{ category: "前端开发", total: 12, averageProgress: 55.5 }],
  summary: "共 12 项，已完成 4 项、进行中 6 项、未开始 2 项，平均进度 55.5%，逾期未完成 1 项。",
};

describe("assistant intent contract", () => {
  it("splits a filtered export and report request into independently verifiable goals", () => {
    const contract = buildAssistantIntentContract({ message: request, projectId: "project-1" });

    expect(contract.exportIntent).toEqual({
      exportType: "gantt",
      taskCategoryKeywords: ["前端"],
      includeProgressReport: true,
    });
    expect(contract.objectives).toMatchObject([
      { id: "O1", action: "EXPORT", required: true },
      { id: "O2", action: "ANALYZE", required: true, dependsOn: ["O1"] },
    ]);
    expect(contract.deliverables.map((item) => item.type)).toEqual(["FILE", "FILE"]);
  });

  it("does not claim completion when the export file exists but the requested report is missing", () => {
    const contract = buildAssistantIntentContract({ message: request, projectId: "project-1" });
    const verification = verifyAssistantIntentCompletion(contract, action({
      downloadUrl: "/api/assistant/actions/action-1/download",
      matchedRowCount: 12,
    }));

    expect(verification.allRequiredPassed).toBe(false);
    expect(verification.completedObjectives).toBe(1);
    expect(verification.missingDeliverables).toEqual(["任务进度总结报告"]);
  });

  it("completes only after both the file and the progress report are available", () => {
    const contract = buildAssistantIntentContract({ message: request, projectId: "project-1" });
    const completedAction = action({
      message: "导出文件和进度报告已生成",
      downloadUrl: "/api/assistant/actions/action-1/download",
      matchedRowCount: 12,
      progressReport,
      includesProgressReport: true,
      workbookSheets: ["项目进度", "进度总结"],
    });
    const verification = verifyAssistantIntentCompletion(contract, completedAction);
    const answer = composeVerifiedAssistantActionAnswer({ contract, action: completedAction, verification });

    expect(verification.allRequiredPassed).toBe(true);
    expect(verification.completedObjectives).toBe(2);
    expect(answer).toContain("已完成你的全部 2 项要求");
    expect(answer).toContain("任务进度总结");
    expect(answer).toContain("平均进度 55.5%");
    expect(answer).toContain("共 12 条记录");
  });

  it("builds an auditable public trace from real observations and tool results", () => {
    const contract = buildAssistantIntentContract({ message: request, projectId: "project-1" });
    const completedAction = action({
      message: "导出文件和进度报告已生成",
      downloadUrl: "/api/assistant/actions/action-1/download",
      matchedRowCount: 12,
      progressReport,
      includesProgressReport: true,
      workbookSheets: ["项目进度", "进度总结"],
    });
    const verification = verifyAssistantIntentCompletion(contract, completedAction);
    const events = buildAssistantCompletedTraceEvents({
      contract,
      observation: {
        exportType: "gantt",
        totalRows: 460,
        matchedRows: 12,
        appliedFilters: ["任务类别包含“前端”"],
      },
      action: completedAction,
      verification,
      toolArgs: contract.exportIntent,
    });

    expect(events.map((event) => event.phase)).toEqual([
      "UNDERSTAND",
      "OBSERVE",
      "PLAN",
      "VALIDATE",
      "EXECUTE",
      "VERIFY",
      "SYNTHESIZE",
    ]);
    expect(events.find((event) => event.phase === "EXECUTE")).toMatchObject({
      toolId: "project.export",
      status: "SUCCEEDED",
    });
    expect(events.find((event) => event.phase === "VERIFY")?.summary).toContain("2/2");
  });

  it("requires the budget workbook to contain a visualization sheet when requested", () => {
    const contract = buildAssistantIntentContract({
      message: "将项目预算管理整理成表并导出，而且需要数据可视化",
      projectId: "project-1",
    });
    const incomplete = verifyAssistantIntentCompletion(contract, action({
      downloadUrl: "/api/assistant/actions/action-1/download",
      matchedRowCount: 4,
      workbookSheets: ["人力预算", "采购预算", "预算汇总"],
    }));
    const complete = verifyAssistantIntentCompletion(contract, action({
      downloadUrl: "/api/assistant/actions/action-1/download",
      matchedRowCount: 4,
      includesVisualization: true,
      workbookSheets: ["人力预算", "采购预算", "预算汇总", "数据可视化"],
    }));

    expect(contract.objectives).toMatchObject([
      { id: "O1", action: "EXPORT", domain: "BUDGET" },
      { id: "O2", action: "ANALYZE", domain: "BUDGET" },
    ]);
    expect(incomplete.allRequiredPassed).toBe(false);
    expect(incomplete.missingDeliverables).toEqual(["预算汇总与数据可视化工作表"]);
    expect(complete.allRequiredPassed).toBe(true);
  });

  it("verifies ordinary query and report goals against the actual final answer", () => {
    const contract = buildAssistantIntentContract({
      message: "分析当前项目风险并给出建议",
      projectId: "project-1",
    });
    const missing = verifyAssistantIntentCompletion(contract, null, { answer: "" });
    const complete = verifyAssistantIntentCompletion(contract, null, { answer: "当前有两项风险，建议优先处理交付延期。" });

    expect(missing.allRequiredPassed).toBe(false);
    expect(complete).toMatchObject({
      allRequiredPassed: true,
      completedObjectives: 1,
      requiredObjectives: 1,
      missingDeliverables: [],
    });
  });
});
