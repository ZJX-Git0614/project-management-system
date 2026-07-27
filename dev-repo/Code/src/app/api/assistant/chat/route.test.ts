import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const prisma = {
    assistantChatMessage: {
      create: vi.fn(),
    },
    assistantActionRun: {
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  }
  return {
    requireUser: vi.fn(),
    loadAssistantRuntimeConfig: vi.fn(),
    proposeAssistantAction: vi.fn(),
    serializeAssistantAction: vi.fn(),
    buildProjectAssistantContext: vi.fn(),
    buildDatabaseAssistantAnswer: vi.fn(),
    callProjectAssistantModel: vi.fn(),
    planProjectAssistantActionWithModel: vi.fn(),
    planProjectAssistantQueryWithModel: vi.fn(),
    shouldPlanProjectAssistantAction: vi.fn(),
    queryRagLite: vi.fn(),
    prisma,
  }
})

vi.mock("@/lib/server-auth", () => ({ requireUser: mocks.requireUser }))
vi.mock("@/lib/assistant-settings", () => ({
  loadAssistantRuntimeConfig: mocks.loadAssistantRuntimeConfig,
}))
vi.mock("@/lib/assistant-actions", () => ({
  proposeAssistantAction: mocks.proposeAssistantAction,
  serializeAssistantAction: mocks.serializeAssistantAction,
}))
vi.mock("@/lib/project-assistant", () => ({
  buildProjectAssistantContext: mocks.buildProjectAssistantContext,
  buildDatabaseAssistantAnswer: mocks.buildDatabaseAssistantAnswer,
}))
vi.mock("@/lib/project-assistant-model", () => ({
  callProjectAssistantModel: mocks.callProjectAssistantModel,
  planProjectAssistantActionWithModel: mocks.planProjectAssistantActionWithModel,
  planProjectAssistantQueryWithModel: mocks.planProjectAssistantQueryWithModel,
  shouldPlanProjectAssistantAction: mocks.shouldPlanProjectAssistantAction,
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

const request = (message: string) => new Request("http://localhost/api/assistant/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message, projectId: "project-1", history: [] }),
}) as never

describe("POST /api/assistant/chat", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireUser.mockResolvedValue({
      userId: "user-1",
      username: "admin",
      displayName: "管理员",
      assignedRoleNames: ["管理员"],
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
      llmProvider: { id: "provider-1", name: "本地模型", model: "qwen3" },
      embeddingProvider: null,
    })
    mocks.proposeAssistantAction.mockResolvedValue(null)
    mocks.planProjectAssistantActionWithModel.mockResolvedValue(null)
    mocks.planProjectAssistantQueryWithModel.mockResolvedValue(null)
    mocks.shouldPlanProjectAssistantAction.mockReturnValue(false)
    mocks.buildProjectAssistantContext.mockResolvedValue(context)
    mocks.callProjectAssistantModel.mockResolvedValue(null)
    mocks.queryRagLite.mockResolvedValue(null)
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

  it("binds a model-normalized command to the exact white-listed agent tool", async () => {
    mocks.shouldPlanProjectAssistantAction.mockReturnValue(true)
    mocks.planProjectAssistantActionWithModel.mockResolvedValue({
      toolId: "weekly.status.update",
      command: "将 Matter007 更新为进行中，当前进度 35%",
    })
    mocks.proposeAssistantAction
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "action-1",
        toolId: "weekly.status.update",
        title: "更新项目事项",
        description: "Matter007 更新为进行中",
        riskLevel: "MEDIUM",
        status: "PROPOSED",
        expiresAt: "2026-07-28T00:00:00.000Z",
      })

    const { POST } = await import("./route")
    const response = await POST(request("把第七个事项推进到百分之三十五并设为处理中"))

    expect(response.status).toBe(200)
    expect(mocks.proposeAssistantAction).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: "将 Matter007 更新为进行中，当前进度 35%",
      expectedToolId: "weekly.status.update",
    }))
    expect(mocks.callProjectAssistantModel).not.toHaveBeenCalled()
  })
})
