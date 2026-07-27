import { beforeEach, describe, expect, it, vi } from "vitest"

const { callAssistantProviderModel } = vi.hoisted(() => ({
  callAssistantProviderModel: vi.fn(),
}))

vi.mock("@/lib/assistant-provider-client", () => ({ callAssistantProviderModel }))

import type { AssistantRuntimeConfig } from "@/lib/assistant-settings"
import type { ProjectAssistantContext } from "@/lib/project-assistant"
import {
  callProjectAssistantModel,
  planProjectAssistantActionWithModel,
  planProjectAssistantQueryWithModel,
  shouldPlanProjectAssistantAction,
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
    const request = callAssistantProviderModel.mock.calls[0][0]
    expect(request.messages[0].content).toContain("白名单工具")
    expect(request.messages[0].content).toContain("不得生成数据库 ID")
  })
})
