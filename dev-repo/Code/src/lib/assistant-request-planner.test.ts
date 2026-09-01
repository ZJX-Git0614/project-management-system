import { describe, expect, it } from "vitest";

import {
  mergeAssistantRequestAnalysis,
  parseAssistantRequestAnalysisResponse,
} from "@/lib/assistant-request-planner";
import { buildAssistantIntentContract } from "@/lib/assistant-intent-contract";

describe("assistant request planner", () => {
  it("keeps every explicit objective and deliverable in a compound request", () => {
    const parsed = parseAssistantRequestAnalysisResponse(JSON.stringify({
      understanding: "筛选全部前端任务，导出任务文件，并基于同一范围生成进度总结报告",
      queryDomains: ["TASK"],
      objectives: [
        { action: "EXPORT", domain: "GANTT", description: "导出全部前端任务", required: true },
        { action: "ANALYZE", domain: "GANTT", description: "总结同一批前端任务的进度", required: true },
      ],
      deliverables: [
        { type: "FILE", label: "前端任务 Excel", required: true, objectiveIndexes: [0] },
        { type: "CHAT_REPORT", label: "前端任务进度总结", required: true, objectiveIndexes: [1] },
      ],
      constraints: ["任务类别包含前端", "分析范围必须与导出范围一致"],
    }));

    expect(parsed).not.toBeNull();
    expect(parsed?.objectives).toHaveLength(2);
    expect(parsed?.deliverables).toHaveLength(2);
    expect(parsed?.queryDomains).toEqual(["TASK"]);
  });

  it("rejects unsupported domains and malformed objective references", () => {
    expect(parseAssistantRequestAnalysisResponse(JSON.stringify({
      understanding: "读取任意数据库表",
      queryDomains: ["SQL"],
      objectives: [{ action: "QUERY", domain: "SQL", description: "读取数据库", required: true }],
      deliverables: [{ type: "CHAT_ANSWER", label: "结果", required: true, objectiveIndexes: [9] }],
    }))).toBeNull();
  });

  it("does not allow the model analysis to remove deterministic export requirements", () => {
    const request = "帮我导出所有前端任务，并总结当前前端任务进度形成报告";
    const base = buildAssistantIntentContract({ message: request, projectId: "project-1" });
    const merged = mergeAssistantRequestAnalysis(base, {
      understanding: "导出前端任务",
      queryDomains: ["TASK"],
      objectives: [{
        id: "M1",
        action: "EXPORT",
        domain: "GANTT",
        description: "导出前端任务",
        required: true,
        dependsOn: [],
      }],
      deliverables: [{
        id: "MD1",
        type: "FILE",
        label: "前端任务文件",
        required: true,
        objectiveIds: ["M1"],
      }],
      constraints: ["任务类别包含前端"],
      confidence: 0.9,
    });

    expect(merged.objectives.some((objective) => objective.action === "ANALYZE")).toBe(true);
    expect(merged.deliverables.some((deliverable) => deliverable.label.includes("总结报告"))).toBe(true);
    expect(merged.constraints).toEqual(expect.arrayContaining(base.constraints));
  });
});
