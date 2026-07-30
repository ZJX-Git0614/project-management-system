import { describe, expect, it } from "vitest";

import { buildScheduleWorkflowSteps } from "@/lib/assistant-plans";

describe("assistant domain workflow planning", () => {
  it("builds a dependency-aware plan for comparison, report, risk and remediation", () => {
    const steps = buildScheduleWorkflowSteps("分析上传的 MPP，与当前进度对比，导出冲突报告，把严重冲突转为风险并生成整改待办");

    expect(steps?.map((step) => step.toolId)).toEqual([
      "schedule.compare.file",
      "schedule.analysis.export",
      "risk.create.from-analysis",
      "todo.create.batch",
    ]);
    expect(steps?.slice(1).every((step) => step.dependsOn.includes(0))).toBe(true);
  });

  it("does not create a multi-step plan for a plain comparison", () => {
    expect(buildScheduleWorkflowSteps("对比这个计划与当前甘特任务的差异")).toBeNull();
  });
});
