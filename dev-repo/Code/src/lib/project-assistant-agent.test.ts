import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proposeAssistantAction: vi.fn(),
  planProjectAssistantActionWithModel: vi.fn(),
  shouldPlanProjectAssistantAction: vi.fn(),
  createAssistantWorkflowPlan: vi.fn(),
  createAssistantWorkflowPlanFromSteps: vi.fn(),
  resumeAssistantWorkflowPlan: vi.fn(),
  planProjectAssistantWorkflowWithModel: vi.fn(),
  shouldPlanProjectAssistantWorkflow: vi.fn(),
  observeAssistantProjectExportData: vi.fn(),
}));

vi.mock("@/lib/assistant-actions", () => ({ proposeAssistantAction: mocks.proposeAssistantAction }));
vi.mock("@/lib/project-assistant-model", () => ({
  planProjectAssistantActionWithModel: mocks.planProjectAssistantActionWithModel,
  shouldPlanProjectAssistantAction: mocks.shouldPlanProjectAssistantAction,
  planProjectAssistantWorkflowWithModel: mocks.planProjectAssistantWorkflowWithModel,
  shouldPlanProjectAssistantWorkflow: mocks.shouldPlanProjectAssistantWorkflow,
}));
vi.mock("@/lib/assistant-plans", () => ({
  createAssistantWorkflowPlan: mocks.createAssistantWorkflowPlan,
  createAssistantWorkflowPlanFromSteps: mocks.createAssistantWorkflowPlanFromSteps,
  resumeAssistantWorkflowPlan: mocks.resumeAssistantWorkflowPlan,
}));
vi.mock("@/lib/assistant-export-observation", () => ({
  observeAssistantProjectExportData: mocks.observeAssistantProjectExportData,
  formatAssistantExportDataObservation: (value: unknown) => JSON.stringify(value),
}));

import { resolveProjectAssistantAction } from "@/lib/project-assistant-agent";
import type { AssistantRuntimeConfig } from "@/lib/assistant-settings";
import type { AuthenticatedUser } from "@/lib/server-auth";

const runtime = {
  agentEnabled: true,
  agentEnabledToolIds: ["weekly.status.update"],
} as AssistantRuntimeConfig;

const user = {
  userId: "user-1",
  username: "admin",
  displayName: "管理员",
  assignedRoleNames: ["管理员"],
  assistantAccessMode: "REQUEST_APPROVAL",
} as AuthenticatedUser;

describe("project assistant agent resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shouldPlanProjectAssistantAction.mockReturnValue(true);
    mocks.planProjectAssistantActionWithModel.mockResolvedValue(null);
    mocks.proposeAssistantAction.mockResolvedValue(null);
    mocks.createAssistantWorkflowPlan.mockResolvedValue(null);
    mocks.resumeAssistantWorkflowPlan.mockResolvedValue(null);
    mocks.planProjectAssistantWorkflowWithModel.mockResolvedValue(null);
    mocks.shouldPlanProjectAssistantWorkflow.mockReturnValue(false);
    mocks.observeAssistantProjectExportData.mockResolvedValue({
      exportType: "gantt",
      totalRows: 460,
      matchedRows: 120,
      appliedFilters: [],
      taskCategories: [{ name: "前端开发", count: 120 }],
    });
  });

  it("returns an explicit trace for a deterministic tool match", async () => {
    mocks.proposeAssistantAction.mockResolvedValue({ toolId: "weekly.status.update" });

    const result = await resolveProjectAssistantAction({
      message: "将 Matter007 更新为进行中",
      projectId: "project-1",
      user,
      runtime,
    });

    expect(result.action).toMatchObject({ toolId: "weekly.status.update" });
    expect(result.trace).toMatchObject({
      outcome: "ACTION_READY",
      toolId: "weekly.status.update",
      steps: [
        { stage: "WORKFLOW_PLAN", outcome: "NO_MATCH" },
        { stage: "DETERMINISTIC_MATCH", outcome: "MATCHED" },
      ],
    });
    expect(mocks.planProjectAssistantActionWithModel).not.toHaveBeenCalled();
  });

  it("validates a model-normalized command through the same deterministic tool boundary", async () => {
    mocks.proposeAssistantAction
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ toolId: "weekly.status.update" });
    mocks.planProjectAssistantActionWithModel.mockResolvedValue({
      toolId: "weekly.status.update",
      command: "将 Matter007 更新为进行中，当前进度 35%",
    });

    const result = await resolveProjectAssistantAction({
      message: "把第七个事项推进到百分之三十五并设为处理中",
      projectId: "project-1",
      user,
      runtime,
      history: [],
    });

    expect(mocks.proposeAssistantAction).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: "将 Matter007 更新为进行中，当前进度 35%",
      expectedToolId: "weekly.status.update",
      plannedArgs: undefined,
    }));
    expect(result.trace.steps).toEqual([
      { stage: "WORKFLOW_PLAN", outcome: "NO_MATCH", toolId: undefined },
      { stage: "DETERMINISTIC_MATCH", outcome: "NO_MATCH", toolId: undefined },
      { stage: "MODEL_PLAN", outcome: "MATCHED", toolId: "weekly.status.update" },
      { stage: "PLAN_VALIDATION", outcome: "MATCHED", toolId: "weekly.status.update" },
    ]);
  });

  it("plans filtered exports before execution and passes exact structured arguments", async () => {
    mocks.planProjectAssistantActionWithModel.mockResolvedValue({
      toolId: "project.export",
      command: "只导出第 1、2、3 层任务",
      args: { exportType: "gantt", taskDepths: [1, 2, 3] },
    });
    mocks.proposeAssistantAction.mockResolvedValue({ toolId: "project.export" });

    const result = await resolveProjectAssistantAction({
      message: "只导出1 2 3级任务",
      projectId: "project-1",
      user,
      runtime: { ...runtime, agentEnabledToolIds: ["project.export"] },
    });

    expect(mocks.proposeAssistantAction).toHaveBeenCalledTimes(1);
    expect(mocks.proposeAssistantAction).toHaveBeenCalledWith(expect.objectContaining({
      message: "只导出1 2 3级任务",
      expectedToolId: "project.export",
      plannedArgs: { exportType: "gantt", taskDepths: [1, 2, 3] },
    }));
    expect(result.trace.steps).toEqual([
      { stage: "WORKFLOW_PLAN", outcome: "NO_MATCH", toolId: undefined },
      { stage: "DATA_OBSERVATION", outcome: "MATCHED", toolId: "project.export", detail: "读取 460 条真实记录，按当前条件命中 120 条" },
      { stage: "MODEL_PLAN", outcome: "MATCHED", toolId: "project.export" },
      { stage: "PLAN_VALIDATION", outcome: "MATCHED", toolId: "project.export" },
    ]);
  });

  it("falls back to deterministic export parsing when the model drops requested filters", async () => {
    mocks.planProjectAssistantActionWithModel.mockResolvedValue({
      toolId: "project.export",
      command: "导出任务",
      args: { exportType: "gantt" },
    });
    mocks.proposeAssistantAction
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ toolId: "project.export" });

    const result = await resolveProjectAssistantAction({
      message: "只导出1 2 3级任务",
      projectId: "project-1",
      user,
      runtime: { ...runtime, agentEnabledToolIds: ["project.export"] },
    });

    expect(mocks.proposeAssistantAction).toHaveBeenNthCalledWith(1, expect.objectContaining({
      plannedArgs: { exportType: "gantt" },
    }));
    expect(mocks.proposeAssistantAction).toHaveBeenNthCalledWith(3, expect.objectContaining({
      message: "只导出1 2 3级任务",
    }));
    expect(result.action).toMatchObject({ toolId: "project.export" });
    expect(result.trace.steps).toEqual([
      { stage: "WORKFLOW_PLAN", outcome: "NO_MATCH", toolId: undefined },
      { stage: "DATA_OBSERVATION", outcome: "MATCHED", toolId: "project.export", detail: "读取 460 条真实记录，按当前条件命中 120 条" },
      { stage: "MODEL_PLAN", outcome: "MATCHED", toolId: "project.export" },
      { stage: "PLAN_VALIDATION", outcome: "REJECTED", toolId: "project.export" },
      { stage: "MODEL_REPLAN", outcome: "MATCHED", toolId: "project.export" },
      { stage: "PLAN_VALIDATION", outcome: "REJECTED", toolId: "project.export" },
      { stage: "DETERMINISTIC_MATCH", outcome: "MATCHED", toolId: "project.export" },
    ]);
  });

  it("keeps a frontend category filter and report request in the executable plan", async () => {
    mocks.shouldPlanProjectAssistantWorkflow.mockReturnValue(true);
    mocks.planProjectAssistantActionWithModel.mockResolvedValue({
      toolId: "project.export",
      command: "导出前端任务并生成进度报告",
      args: {
        exportType: "gantt",
        taskCategoryKeywords: ["前端"],
        includeProgressReport: true,
      },
      decisionSummary: "用户只要求前端任务，并要求基于命中任务生成进度报告",
    });
    mocks.proposeAssistantAction.mockResolvedValue({ toolId: "project.export" });

    const result = await resolveProjectAssistantAction({
      message: "帮我导出所有的前端任务，并且对当前前端任务进度总结出一份报告",
      projectId: "project-1",
      user,
      runtime: { ...runtime, agentEnabledToolIds: ["project.export"] },
    });

    expect(mocks.proposeAssistantAction).toHaveBeenCalledWith(expect.objectContaining({
      plannedArgs: {
        exportType: "gantt",
        taskCategoryKeywords: ["前端"],
        includeProgressReport: true,
      },
    }));
    expect(mocks.planProjectAssistantWorkflowWithModel).not.toHaveBeenCalled();
    expect(result.trace).toMatchObject({
      outcome: "ACTION_READY",
      constraints: ["任务类别包含“前端”", "附带进度总结报告"],
      decisionSummary: "用户只要求前端任务，并要求基于命中任务生成进度报告",
      toolArgs: {
        exportType: "gantt",
        taskCategoryKeywords: ["前端"],
        includeProgressReport: true,
      },
      observation: { totalRows: 460, matchedRows: 120 },
    });
  });

  it("records a rejected model plan instead of treating it as an executable action", async () => {
    mocks.planProjectAssistantActionWithModel.mockResolvedValue({
      toolId: "weekly.status.update",
      command: "更新一个不存在的事项",
    });

    const result = await resolveProjectAssistantAction({
      message: "把那个事项改一下",
      projectId: "project-1",
      user,
      runtime,
    });

    expect(result.action).toBeNull();
    expect(result.trace.steps.at(-1)).toEqual({
      stage: "PLAN_VALIDATION",
      outcome: "REJECTED",
      toolId: "weekly.status.update",
    });
  });

  it("skips model planning when a deterministic capability answer already explains missing input", async () => {
    const result = await resolveProjectAssistantAction({
      message: "我给你一个 MPP 文件，你能按系统格式输出吗",
      projectId: "project-1",
      user,
      runtime,
      attachmentIds: [],
      allowModelPlanning: false,
    });

    expect(result.action).toBeNull();
    expect(result.trace.steps).toEqual([
      { stage: "WORKFLOW_PLAN", outcome: "NO_MATCH", toolId: undefined },
      { stage: "DETERMINISTIC_MATCH", outcome: "NO_MATCH", toolId: undefined },
      { stage: "MODEL_PLAN", outcome: "SKIPPED" },
    ]);
    expect(mocks.planProjectAssistantActionWithModel).not.toHaveBeenCalled();
  });
});
