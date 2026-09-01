import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const prisma = {
    assistantChatMessage: {
      create: vi.fn(),
    },
    assistantActionRun: {
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    assistantAttachment: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
  }
  return {
    requireUser: vi.fn(),
    loadAssistantRuntimeConfig: vi.fn(),
    resolveProjectAssistantAction: vi.fn(),
    executeAssistantActionAndAdvancePlan: vi.fn(),
    serializeAssistantAction: vi.fn(),
    buildProjectAssistantContext: vi.fn(),
    buildDatabaseAssistantAnswer: vi.fn(),
    callProjectAssistantModel: vi.fn(),
    planProjectAssistantQueryWithModel: vi.fn(),
    analyzeAssistantRequestWithModel: vi.fn(),
    queryRagLite: vi.fn(),
    prisma,
  }
})

vi.mock("@/lib/server-auth", () => ({ requireUser: mocks.requireUser }))
vi.mock("@/lib/assistant-settings", () => ({
  loadAssistantRuntimeConfig: mocks.loadAssistantRuntimeConfig,
  ASSISTANT_TOOL_CATALOG: [{
    id: "schedule.convert.file",
    attachments: { min: 1, max: 1, extensions: [".mpp", ".xml", ".xlsx"] },
  }],
}))
vi.mock("@/lib/assistant-actions", () => ({
  serializeAssistantAction: mocks.serializeAssistantAction,
}))
vi.mock("@/lib/assistant-plans", () => ({
  executeAssistantActionAndAdvancePlan: mocks.executeAssistantActionAndAdvancePlan,
  serializeAssistantPlan: vi.fn(),
}))
vi.mock("@/lib/project-assistant-agent", () => ({
  resolveProjectAssistantAction: mocks.resolveProjectAssistantAction,
}))
vi.mock("@/lib/project-assistant", () => ({
  buildProjectAssistantContext: mocks.buildProjectAssistantContext,
  buildDatabaseAssistantAnswer: mocks.buildDatabaseAssistantAnswer,
}))
vi.mock("@/lib/project-assistant-model", () => ({
  callProjectAssistantModel: mocks.callProjectAssistantModel,
  planProjectAssistantQueryWithModel: mocks.planProjectAssistantQueryWithModel,
}))
vi.mock("@/lib/assistant-request-planner", () => ({
  analyzeAssistantRequestWithModel: mocks.analyzeAssistantRequestWithModel,
}))
vi.mock("@/lib/raglite-client", () => ({ queryRagLite: mocks.queryRagLite }))
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }))

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
}

const request = (message: string, attachmentIds: string[] = []) => new Request("http://localhost/api/assistant/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message, projectId: "project-1", history: [], attachmentIds }),
}) as never

const streamRequest = (message: string) => new Request("http://localhost/api/assistant/chat", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/x-ndjson",
  },
  body: JSON.stringify({ message, projectId: "project-1", history: [], attachmentIds: [] }),
}) as never

describe("POST /api/assistant/chat", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireUser.mockResolvedValue({
      userId: "user-1",
      username: "admin",
      displayName: "管理员",
      assignedRoleNames: ["管理员"],
      assistantAccessMode: "REQUEST_APPROVAL",
    })
    mocks.loadAssistantRuntimeConfig.mockResolvedValue({
      enabled: true,
      assistantName: "佳佳",
      welcomeMessage: "",
      personaPreset: "PROFESSIONAL",
      avatarPalette: "ICE",
      avatarStyle: "ROUNDED",
      temperature: 0.2,
      maxTokens: 1400,
      historyLimit: 8,
      historyRetentionDays: 90,
      retrievalEnabled: false,
      agentEnabled: false,
      agentEnabledToolIds: [],
      llmProvider: { id: "provider-1", name: "本地模型", model: "qwen3" },
      embeddingProvider: null,
    })
    mocks.resolveProjectAssistantAction.mockResolvedValue({
      action: null,
      trace: { requested: false, outcome: "NO_ACTION", steps: [] },
    })
    mocks.planProjectAssistantQueryWithModel.mockResolvedValue(null)
    mocks.analyzeAssistantRequestWithModel.mockImplementation(async ({ baseContract }) => baseContract)
    mocks.buildProjectAssistantContext.mockResolvedValue(context)
    mocks.callProjectAssistantModel.mockResolvedValue(null)
    mocks.queryRagLite.mockResolvedValue(null)
    mocks.prisma.assistantAttachment.findMany.mockResolvedValue([])
    mocks.prisma.assistantActionRun.findFirst.mockResolvedValue(null)
    mocks.prisma.assistantActionRun.updateMany.mockResolvedValue({ count: 0 })
    mocks.prisma.assistantChatMessage.create.mockImplementation(async ({ data }) => ({
      id: `message-${data.role}`,
      role: data.role,
      content: data.content,
      source: data.source || "",
      trace: data.trace || "{}",
      blocks: data.blocks || "[]",
      createdAt: new Date("2026-07-24T00:00:00.000Z"),
    }))
    mocks.prisma.$transaction.mockImplementation(async (callback) => callback(mocks.prisma))
  })

  it("returns the assistant identity instead of project status when the model misbehaves", async () => {
    const { POST } = await import("./route")
    const response = await POST(request("你是谁？"))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.data.answer).toContain("我是佳佳")
    expect(payload.data.answer).not.toContain("示例项目")
    expect(payload.data.answer).not.toContain("进行中")
    expect(payload.data.source).toBe("SYSTEM")
    expect(payload.data.assistantMessage.trace.intent).toBe("助手身份")
    expect(mocks.planProjectAssistantQueryWithModel).not.toHaveBeenCalled()
    expect(mocks.queryRagLite).not.toHaveBeenCalled()
    expect(mocks.callProjectAssistantModel).toHaveBeenCalledWith(expect.objectContaining({
      intent: expect.objectContaining({ identityOnly: true, domains: ["IDENTITY"] }),
    }))
  })

  it("streams real processing events, answer content, and the persisted result", async () => {
    mocks.callProjectAssistantModel.mockResolvedValue("已根据当前项目数据完成分析。")
    const { POST } = await import("./route")

    const response = await POST(streamRequest("分析当前项目进度"))
    const events = (await response.text())
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; event?: { phase?: string; status?: string }; delta?: string })

    expect(response.headers.get("content-type")).toContain("application/x-ndjson")
    expect(response.headers.get("content-encoding")).toBe("identity")
    expect(events.some((event) => event.type === "trace" && event.event?.phase === "UNDERSTAND" && event.event.status === "RUNNING")).toBe(true)
    expect(events.some((event) => event.type === "trace" && event.event?.phase === "OBSERVE" && event.event.status === "SUCCEEDED")).toBe(true)
    expect(events.some((event) => event.type === "answer_delta" && event.delta?.includes("完成分析"))).toBe(true)
    expect(events.at(-1)?.type).toBe("result")
  })

  it("uses the domain agent resolution without asking the answer model to perform actions", async () => {
    mocks.resolveProjectAssistantAction.mockResolvedValue({
      action: {
        id: "action-1",
        toolId: "weekly.status.update",
        title: "更新项目事项",
        description: "Matter007 更新为进行中",
        riskLevel: "MEDIUM",
        status: "PROPOSED",
        expiresAt: "2026-07-28T00:00:00.000Z",
      },
      trace: {
        requested: true,
        outcome: "ACTION_READY",
        toolId: "weekly.status.update",
        steps: [{ stage: "PLAN_VALIDATION", outcome: "MATCHED", toolId: "weekly.status.update" }],
      },
    })

    const { POST } = await import("./route")
    const response = await POST(request("把第七个事项推进到百分之三十五并设为处理中"))

    expect(response.status).toBe(200)
    expect(mocks.resolveProjectAssistantAction).toHaveBeenCalledWith(expect.objectContaining({
      message: "把第七个事项推进到百分之三十五并设为处理中",
    }))
    expect(mocks.callProjectAssistantModel).not.toHaveBeenCalled()
  })

  it("passes the current attachment IDs to deterministic agent actions", async () => {
    const extraction = {
      content: "任务清单",
      structuredJson: JSON.stringify({ format: "md", sections: [], metadata: {}, truncated: false }),
      diagnosticsJson: "[]",
    }
    mocks.prisma.assistantAttachment.findMany.mockResolvedValue([
      { id: "attachment-1", originalName: "计划一.md", extraction },
      { id: "attachment-2", originalName: "计划二.xlsx", extraction },
    ])
    mocks.resolveProjectAssistantAction.mockResolvedValue({
      action: {
        id: "action-merge",
        toolId: "schedule.merge.files",
        title: "合并进度计划文件",
        description: "合并两个文件",
        riskLevel: "LOW",
        status: "PROPOSED",
        expiresAt: "2026-07-28T00:00:00.000Z",
      },
      trace: { requested: true, outcome: "ACTION_READY", toolId: "schedule.merge.files", steps: [] },
    })

    const { POST } = await import("./route")
    const response = await POST(request("合并这两个进度计划并生成可导入 Excel", ["attachment-1", "attachment-2"]))

    expect(response.status).toBe(200)
    expect(mocks.resolveProjectAssistantAction).toHaveBeenCalledWith(expect.objectContaining({
      attachmentIds: ["attachment-1", "attachment-2"],
    }))
    expect(mocks.callProjectAssistantModel).not.toHaveBeenCalled()
  })

  it("uses the local manual for system operation questions", async () => {
    const { POST } = await import("./route")
    const response = await POST(request("怎么把 Task2 变成上一条任务的子任务？"))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.data.answer).toContain("层级下移")
    expect(payload.data.source).toBe("SYSTEM")
    expect(mocks.callProjectAssistantModel).toHaveBeenCalledWith(expect.objectContaining({
      manualContext: expect.stringContaining("上一条同级任务"),
    }))
  })

  it("answers the exact MPP conversion capability question from server capabilities", async () => {
    mocks.loadAssistantRuntimeConfig.mockResolvedValue({
      ...(await mocks.loadAssistantRuntimeConfig()),
      agentEnabled: true,
      agentEnabledToolIds: ["schedule.convert.file"],
    })

    const { POST } = await import("./route")
    const response = await POST(request("我给你一个mpp文件，你能帮我按照系统的甘特任务格式输出文件吗"))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.data.source).toBe("SYSTEM")
    expect(payload.data.answer).toContain("请上传一个 MPP")
    expect(payload.data.answer).not.toContain("不支持解析 mpp")
    expect(mocks.resolveProjectAssistantAction).toHaveBeenCalledWith(expect.objectContaining({
      allowModelPlanning: false,
    }))
    expect(payload.data.assistantMessage.trace.evidence).toContainEqual(expect.objectContaining({
      source: "佳佳服务端能力目录",
    }))
    expect(mocks.callProjectAssistantModel).not.toHaveBeenCalled()
  })

  it("auto executes medium-risk actions in auto-approve mode", async () => {
    mocks.requireUser.mockResolvedValue({
      userId: "user-1",
      username: "admin",
      displayName: "管理员",
      assignedRoleNames: ["管理员"],
      assistantAccessMode: "AUTO_APPROVE",
    })
    const proposal = {
      id: "action-1",
      toolId: "weekly.status.update",
      title: "更新项目事项",
      description: "Matter007 更新为进行中",
      riskLevel: "MEDIUM",
      status: "PROPOSED",
      expiresAt: "2026-07-29T00:00:00.000Z",
    }
    const rawAction = { id: "action-1", userId: "user-1", status: "PROPOSED" }
    const result = {
      ...proposal,
      status: "SUCCEEDED",
      result: { message: "事项状态已更新" },
    }
    mocks.resolveProjectAssistantAction.mockResolvedValue({
      action: proposal,
      trace: { requested: true, outcome: "ACTION_READY", toolId: proposal.toolId, steps: [] },
    })
    mocks.prisma.assistantActionRun.findFirst.mockResolvedValue(rawAction)
    mocks.executeAssistantActionAndAdvancePlan.mockResolvedValue({ action: result })

    const { POST } = await import("./route")
    const response = await POST(request("将 Matter007 更新为进行中，当前进度 35%"))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(mocks.executeAssistantActionAndAdvancePlan).toHaveBeenCalledWith(rawAction, expect.objectContaining({ userId: "user-1" }))
    expect(payload.data.answer).toContain("已执行")
    expect(payload.data.assistantMessage.blocks[0]).toMatchObject({
      type: "action-result",
      action: { status: "SUCCEEDED" },
    })
  })

  it("finishes a filtered export only after the file and requested report are both verified", async () => {
    mocks.requireUser.mockResolvedValue({
      userId: "user-1",
      username: "admin",
      displayName: "管理员",
      assignedRoleNames: ["管理员"],
      assistantAccessMode: "AUTO_APPROVE",
    })
    const proposal = {
      id: "action-export",
      toolId: "project.export",
      title: "导出任务进度",
      description: "仅导出前端任务并生成进度报告",
      riskLevel: "LOW",
      status: "PROPOSED",
      expiresAt: "2026-08-03T00:00:00.000Z",
    }
    const completed = {
      ...proposal,
      status: "SUCCEEDED",
      result: {
        message: "导出文件和进度报告已生成",
        downloadUrl: "/api/assistant/actions/action-export/download",
        matchedRowCount: 12,
        progressReport: {
          total: 12,
          completed: 4,
          inProgress: 6,
          notStarted: 2,
          overdue: 1,
          averageProgress: 55.5,
          categoryBreakdown: [{ category: "前端开发", total: 12, averageProgress: 55.5 }],
          summary: "共 12 项，已完成 4 项、进行中 6 项、未开始 2 项，平均进度 55.5%，逾期未完成 1 项。",
        },
        includesProgressReport: true,
        workbookSheets: ["项目进度", "进度总结"],
      },
    }
    mocks.resolveProjectAssistantAction.mockResolvedValue({
      action: proposal,
      trace: {
        requested: true,
        outcome: "ACTION_READY",
        toolId: "project.export",
        objective: "导出前端任务并生成进度报告",
        constraints: ["任务类别包含“前端”", "附带进度总结报告"],
        observation: {
          exportType: "gantt",
          totalRows: 460,
          matchedRows: 12,
          appliedFilters: ["任务类别包含“前端”", "附带进度总结报告"],
        },
        toolArgs: {
          exportType: "gantt",
          taskCategoryKeywords: ["前端"],
          includeProgressReport: true,
        },
        steps: [],
      },
    })
    mocks.prisma.assistantActionRun.findFirst.mockResolvedValue({ id: proposal.id, userId: "user-1", status: "PROPOSED" })
    mocks.executeAssistantActionAndAdvancePlan.mockResolvedValue({ action: completed })

    const { POST } = await import("./route")
    const response = await POST(request("帮我导出所有的前端任务，并且对当前前端任务进度总结出一份报告"))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.data.answer).toContain("已完成你的全部 2 项要求")
    expect(payload.data.answer).toContain("任务进度总结")
    expect(payload.data.answer).toContain("共 12 条记录")
    expect(payload.data.assistantMessage.trace.agent.goalVerification).toMatchObject({
      allRequiredPassed: true,
      completedObjectives: 2,
      requiredObjectives: 2,
    })
    expect(payload.data.assistantMessage.trace.agent.events.map((event: { phase: string }) => event.phase)).toEqual([
      "UNDERSTAND",
      "OBSERVE",
      "PLAN",
      "VALIDATE",
      "EXECUTE",
      "VERIFY",
      "SYNTHESIZE",
    ])
  })
})
