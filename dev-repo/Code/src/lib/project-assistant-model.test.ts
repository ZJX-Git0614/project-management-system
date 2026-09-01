import { beforeEach, describe, expect, it, vi } from "vitest"

const { callAssistantProviderModel } = vi.hoisted(() => ({
  callAssistantProviderModel: vi.fn(),
}))

vi.mock("@/lib/assistant-provider-client", () => ({ callAssistantProviderModel }))

import type { AssistantRuntimeConfig } from "@/lib/assistant-settings"
import type { ProjectAssistantContext } from "@/lib/project-assistant"
import {
  callProjectAssistantModel,
  parseActionWorkflowPlannerResponse,
  planProjectAssistantActionWithModel,
  planProjectAssistantWorkflowWithModel,
  planProjectAssistantQueryWithModel,
  shouldPlanProjectAssistantAction,
  shouldPlanProjectAssistantWorkflow,
} from "@/lib/project-assistant-model"
import { detectProjectAssistantQueryIntent } from "@/lib/project-assistant-query"

const runtime = {
  enabled: true,
  assistantName: "佳佳",
  welcomeMessage: "",
  systemPrompt: "只回答已授权内容",
  personaPreset: "PROFESSIONAL",
  personaCustomPrompt: "",
  avatarPalette: "ICE",
  avatarStyle: "ROUNDED",
  temperature: 0.2,
  maxTokens: 1400,
  historyLimit: 8,
  historyRetentionDays: 90,
  retrievalEnabled: false,
  retrievalTopK: 6,
  chunkMaxSize: 2048,
  vectorDistanceMetric: "cosine",
  vectorSearchMultivector: true,
  vectorSearchQueryAdapter: true,
  rerankerEnabled: true,
  agentEnabled: true,
  agentEnabledToolIds: [],
  agentMaxExportRows: 5000,
  agentActionExpiryMinutes: 15,
  ragliteBaseUrl: "",
  ragliteToken: "",
  embeddingProvider: null,
  llmProvider: {
    id: "provider-1",
    providerKind: "LLM",
    providerType: "OLLAMA",
    name: "本地模型",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3",
    apiKey: "",
  },
} as AssistantRuntimeConfig

const context = {
  generatedAt: "2026-07-24T00:00:00.000Z",
  user: { id: "user-1", username: "admin", displayName: "管理员" },
  portfolio: { total: 1, statuses: { 进行中: 1 }, projects: [] },
  project: { id: "project-1", name: "示例项目", code: "P001", statusLabel: "进行中" },
  members: [],
  progress: { total: 1, completed: 0, average: 60, overdue: 0, tasks: [{ code: "Task001" }] },
  weeklyItems: [],
  budget: { contractAmount: 0, total: 0, remaining: 0, profitTargetRate: 0, categories: [] },
  risks: [],
  documents: [],
  todos: [],
  recentOperations: [],
} as unknown as ProjectAssistantContext

describe("project assistant model routing", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("gives identity questions an immutable identity prompt without project details", async () => {
    callAssistantProviderModel.mockResolvedValue("我是佳佳")
    const intent = detectProjectAssistantQueryIntent("你是谁？")

    const answer = await callProjectAssistantModel({
      message: "你是谁？",
      history: [],
      context,
      rag: null,
      runtime,
      intent,
    })

    expect(answer).toBe("我是佳佳")
    const request = callAssistantProviderModel.mock.calls[0][0]
    expect(request.messages[0].content).toContain("你的名字是“佳佳”")
    expect(request.messages[0].content).toContain("不得回答项目状态")
    expect(request.messages.at(-1).content).not.toContain("Task001")
    expect(request.messages.at(-1).content).not.toContain("示例项目")
  })

  it("rejects a project-status answer for an identity question so the route can use the identity fallback", async () => {
    callAssistantProviderModel.mockResolvedValue("当前项目处于进行中状态，任务平均进度为 60%。")

    const answer = await callProjectAssistantModel({
      message: "你是谁？",
      history: [],
      context,
      rag: null,
      runtime,
      intent: detectProjectAssistantQueryIntent("你是谁？"),
    })

    expect(answer).toBeNull()
  })

  it("uses the model as an RPMS-style planner for ambiguous follow-up questions", async () => {
    callAssistantProviderModel.mockResolvedValue('{"domains":["TASK","RISK"]}')

    const intent = await planProjectAssistantQueryWithModel({
      message: "那延期的呢？",
      history: [{ role: "user", content: "先看一下当前项目" }],
      runtime,
    })

    expect(intent?.domains).toEqual(["TASK", "RISK"])
    const request = callAssistantProviderModel.mock.calls[0][0]
    expect(request.temperature).toBe(0)
    expect(request.messages[0].content).toContain("白名单业务域")
    expect(request.messages[0].content).toContain("不得生成 SQL")
  })

  it("uses the model only to normalize explicit white-listed agent actions", async () => {
    callAssistantProviderModel.mockResolvedValue('{"toolId":"weekly.status.update","command":"将 Matter007 更新为进行中，当前进度 35%"}')

    const plan = await planProjectAssistantActionWithModel({
      message: "把第七个事项推进到百分之三十五并设为处理中",
      history: [],
      runtime: {
        ...runtime,
        agentEnabledToolIds: ["weekly.status.update"],
      },
    })

    expect(plan).toEqual({
      toolId: "weekly.status.update",
      command: "将 Matter007 更新为进行中，当前进度 35%",
    })
    expect(shouldPlanProjectAssistantAction("有哪些延期事项")).toBe(false)
    expect(shouldPlanProjectAssistantAction("更新 Matter007 的进度")).toBe(true)
    expect(shouldPlanProjectAssistantAction("把两个进度计划合并成可导入文件")).toBe(true)
    expect(shouldPlanProjectAssistantAction("把这个 MPP 按系统格式输出文件")).toBe(true)
    expect(shouldPlanProjectAssistantAction("申请发布当前 WBS 基线")).toBe(true)
    expect(shouldPlanProjectAssistantAction("同意审批《项目状态变更》")).toBe(true)
    expect(shouldPlanProjectAssistantAction("在结构评审会话发送消息：请补充意见")).toBe(true)
    expect(shouldPlanProjectAssistantWorkflow("处理这些内容", {
      version: 1,
      originalRequest: "处理这些内容",
      projectId: "project-1",
      objectives: [
        { id: "O1", action: "UPDATE", domain: "GANTT", description: "更新任务", required: true, dependsOn: [] },
        { id: "O2", action: "EXPORT", domain: "GANTT", description: "导出结果", required: true, dependsOn: ["O1"] },
      ],
      deliverables: [
        { id: "D1", type: "DATABASE_CHANGE", label: "更新结果", required: true, objectiveIds: ["O1"] },
        { id: "D2", type: "FILE", label: "导出文件", required: true, objectiveIds: ["O2"] },
      ],
      constraints: [],
      confidence: 0.9,
    })).toBe(true)
    const request = callAssistantProviderModel.mock.calls[0][0]
    expect(request.messages[0].content).toContain("白名单工具")
    expect(request.messages[0].content).toContain("不得生成数据库 ID")
  })

  it("plans approval processing with a natural-language query instead of inventing an instance id", async () => {
    callAssistantProviderModel.mockResolvedValue(JSON.stringify({
      toolId: "approval.process",
      args: { action: "return", approvalQuery: "发布 WBS 基线", comment: "计划日期未确认" },
      command: "退回审批《发布 WBS 基线》，原因为计划日期未确认",
      decisionSummary: "用户明确指定了审批动作、目标和原因",
    }))

    const plan = await planProjectAssistantActionWithModel({
      message: "退回发布 WBS 基线的审批，原因为计划日期未确认",
      history: [],
      runtime: { ...runtime, agentEnabledToolIds: ["approval.process"] },
    })

    expect(plan).toMatchObject({
      toolId: "approval.process",
      args: { action: "return", approvalQuery: "发布 WBS 基线", comment: "计划日期未确认" },
    })
    expect(plan?.args).not.toHaveProperty("instanceId")
    const request = callAssistantProviderModel.mock.calls[0][0]
    expect(request.messages[0].content).toContain("不得编造 instanceId")
  })

  it("plans referenced risk analysis as a complete batch action with full recent context", async () => {
    callAssistantProviderModel.mockResolvedValue(JSON.stringify({
      toolId: "risk.create.batch",
      args: {
        risks: [
          { riskName: "项目延期风险", level: "高", status: "识别中" },
          { riskName: "成本超支风险", level: "中", status: "识别中" },
        ],
      },
      command: "将前文分析建议的两条风险写入风险登记册",
      decisionSummary: "用户引用前文的复数风险，必须批量登记",
    }))
    const previousAnalysis = `${"分析依据".repeat(180)}\n建议风险：项目延期风险、成本超支风险`

    const plan = await planProjectAssistantActionWithModel({
      message: "帮我把以上风险写入风险登记册",
      history: [{ role: "assistant", content: previousAnalysis }],
      runtime: { ...runtime, agentEnabledToolIds: ["risk.create", "risk.create.batch"] },
    })

    expect(plan?.toolId).toBe("risk.create.batch")
    expect(plan?.args).toMatchObject({ risks: expect.arrayContaining([expect.objectContaining({ riskName: "项目延期风险" })]) })
    const request = callAssistantProviderModel.mock.calls[0][0]
    expect(request.maxTokens).toBe(1600)
    expect(request.messages[0].content).toContain("不得选择 risk.create")
    expect(request.messages.at(-1).content).toContain("建议风险：项目延期风险、成本超支风险")
  })

  it("requires structured and schema-valid filters for project exports", async () => {
    callAssistantProviderModel.mockResolvedValue(JSON.stringify({
      toolId: "project.export",
      args: { exportType: "gantt", taskDepths: [1, 2, 3] },
      command: "只导出第 1、2、3 层甘特任务",
      decisionSummary: "用户明确限定了三个任务层级",
    }))

    const plan = await planProjectAssistantActionWithModel({
      message: "只导出1 2 3级任务",
      history: [],
      runtime: { ...runtime, agentEnabledToolIds: ["project.export"] },
    })

    expect(plan).toEqual({
      toolId: "project.export",
      args: { exportType: "gantt", taskDepths: [1, 2, 3] },
      command: "只导出第 1、2、3 层甘特任务",
      decisionSummary: "用户明确限定了三个任务层级",
    })
    const request = callAssistantProviderModel.mock.calls[0][0]
    expect(request.messages[0].content).toContain("多个任务层级必须完整写入 taskDepths")
    expect(request.messages[0].content).toContain("当前版本能力清单")

    callAssistantProviderModel.mockResolvedValue(JSON.stringify({
      toolId: "project.export",
      args: { exportType: "gantt", taskDepths: [0] },
      command: "导出任务",
    }))
    await expect(planProjectAssistantActionWithModel({
      message: "导出零级任务",
      history: [],
      runtime: { ...runtime, agentEnabledToolIds: ["project.export"] },
    })).resolves.toBeNull()
  })

  it("plans category-filtered exports with a progress report from observed project data", async () => {
    callAssistantProviderModel.mockResolvedValue(JSON.stringify({
      toolId: "project.export",
      args: { exportType: "gantt", taskCategoryKeywords: ["前端"], includeProgressReport: true },
      command: "导出前端任务并生成进度报告",
      decisionSummary: "数据库观察显示存在前端类别，且用户要求进度报告",
    }))

    const plan = await planProjectAssistantActionWithModel({
      message: "帮我导出所有的前端任务，并且对当前前端任务进度总结出一份报告",
      history: [],
      runtime: { ...runtime, agentEnabledToolIds: ["project.export"] },
      dataObservation: JSON.stringify({ totalRows: 461, matchedRows: 120, taskCategories: [{ name: "前端开发", count: 120 }] }),
    })

    expect(plan?.args).toEqual({
      exportType: "gantt",
      taskCategoryKeywords: ["前端"],
      includeProgressReport: true,
    })
    const request = callAssistantProviderModel.mock.calls[0][0]
    expect(request.messages[0].content).toContain("taskCategoryKeywords")
    expect(request.messages[0].content).toContain("includeProgressReport:true")
    expect(request.messages[1].content).toContain("前端开发")
    expect(request.messages[1].content).toContain("matchedRows")
  })

  it("accepts at most six acyclic white-listed workflow steps", async () => {
    callAssistantProviderModel.mockResolvedValue(JSON.stringify({
      title: "分析并处置计划冲突",
      steps: [
        { id: "s1", toolId: "schedule.compare.file", command: "对比附件与当前计划", dependsOn: [] },
        { id: "s2", toolId: "schedule.analysis.export", command: "导出最新计划冲突报告", dependsOn: ["s1"] },
        { id: "s3", toolId: "risk.create.from-analysis", command: "将最严重冲突创建为风险", dependsOn: ["s1"] },
      ],
    }))

    const plan = await planProjectAssistantWorkflowWithModel({
      message: "先对比这份计划，再导出报告并把严重冲突创建为风险",
      history: [],
      runtime: {
        ...runtime,
        agentEnabledToolIds: ["schedule.compare.file", "schedule.analysis.export", "risk.create.from-analysis"],
      },
    })

    expect(plan?.steps.map((step) => ({ toolId: step.toolId, dependsOn: step.dependsOn }))).toEqual([
      { toolId: "schedule.compare.file", dependsOn: [] },
      { toolId: "schedule.analysis.export", dependsOn: [0] },
      { toolId: "risk.create.from-analysis", dependsOn: [0] },
    ])
    expect(shouldPlanProjectAssistantWorkflow("更新一个事项")).toBe(false)
    expect(shouldPlanProjectAssistantWorkflow("更新事项并导出风险登记册")).toBe(true)
  })

  it("rejects workflow cycles and tools outside the enabled catalog", () => {
    const enabled = new Set(["schedule.compare.file", "schedule.analysis.export"])
    expect(parseActionWorkflowPlannerResponse(JSON.stringify({ steps: [
      { id: "s1", toolId: "schedule.compare.file", command: "对比计划", dependsOn: ["s2"] },
      { id: "s2", toolId: "schedule.analysis.export", command: "导出报告", dependsOn: ["s1"] },
    ] }), enabled)).toBeNull()
    expect(parseActionWorkflowPlannerResponse(JSON.stringify({ steps: [
      { id: "s1", toolId: "shell.exec", command: "执行命令", dependsOn: [] },
      { id: "s2", toolId: "schedule.analysis.export", command: "导出报告", dependsOn: ["s1"] },
    ] }), enabled)).toBeNull()
  })

  it("keeps validated structured arguments on every workflow step", () => {
    const parsed = parseActionWorkflowPlannerResponse(JSON.stringify({
      title: "生成项目交付物",
      steps: [
        {
          id: "s1",
          toolId: "project.export",
          command: "导出一级和二级任务",
          args: { exportType: "gantt", taskDepths: [1, 2] },
          dependsOn: [],
        },
        {
          id: "s2",
          toolId: "project.report.generate",
          command: "基于任务数据生成进度报告",
          args: {
            title: "项目进度报告",
            instructions: "总结一级和二级任务的计划与实际完成情况",
            domains: ["TASK"],
          },
          dependsOn: ["s1"],
        },
      ],
    }), new Set(["project.export", "project.report.generate"]));

    expect(parsed?.steps[0].args).toEqual({ exportType: "gantt", taskDepths: [1, 2] });
    expect(parsed?.steps[1].args).toEqual(expect.objectContaining({ domains: ["TASK"] }));
  })
})
