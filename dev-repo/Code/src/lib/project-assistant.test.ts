import { describe, expect, it } from "vitest"

import {
  buildDatabaseAssistantAnswer,
  type ProjectAssistantContext,
} from "@/lib/project-assistant"

const context = {
  generatedAt: "2026-07-21T00:00:00.000Z",
  user: { id: "user-1", username: "admin", displayName: "管理员" },
  portfolio: {
    total: 1,
    statuses: { 进行中: 1 },
    projects: [{
      id: "project-1",
      name: "示例项目",
      code: "P001",
      clientName: "客户A",
      amountWan: 100,
      status: "IN_PROGRESS",
      statusLabel: "进行中",
      startDate: "2026-07-01",
      expectedEndDate: "2026-12-31",
    }],
  },
  project: {
    id: "project-1",
    name: "示例项目",
    code: "P001",
    clientName: "客户A",
    amountWan: 100,
    deviceCount: 2,
    startDate: "2026-07-01",
    expectedEndDate: "2026-12-31",
    status: "IN_PROGRESS",
    statusLabel: "进行中",
  },
  members: [{ roleName: "项目经理", personName: "张三" }],
  progress: {
    total: 1,
    completed: 0,
    average: 60,
    overdue: 0,
    tasks: [{
      id: "task-1",
      code: "Task001",
      category: "设计",
      name: "总体方案设计",
      plannedStart: "2026-07-01",
      plannedEnd: "2099-07-10",
      actualStart: "",
      actualEnd: "",
      progress: 60,
      critical: false,
    }],
  },
  weeklyItems: [{
    id: "item-1",
    code: "Matter001",
    title: "完成设计评审",
    taskName: "总体方案设计",
    owner: "张三",
    priority: "高",
    status: "进行中",
    plannedStart: "",
    plannedEnd: "",
    actualStart: "",
    actualEnd: "",
    progress: 30,
    health: "HEALTHY",
    issueAndAction: "",
    risk: "",
  }],
  budget: {
    contractAmount: 1_000_000,
    profitTargetRate: 20,
    total: 300_000,
    remaining: 700_000,
    categories: [{ id: "cat-1", name: "研发成本", kind: "MANPOWER", subtotal: 300_000, items: [] }],
  },
  risks: [],
  documents: [],
  todos: [],
  recentOperations: [],
} as unknown as ProjectAssistantContext

describe("project assistant database answers", () => {
  it("returns task progress from the current project context", () => {
    const answer = buildDatabaseAssistantAnswer("查看任务进度", context)

    expect(answer).toContain("任务进度")
    expect(answer).toContain("Task001")
    expect(answer).toContain("60%")
  })

  it("searches across project records when no fixed intent matches", () => {
    const answer = buildDatabaseAssistantAnswer("方案设计", context)

    expect(answer).toContain("项目内搜索结果")
    expect(answer).toContain("Matter001")
    expect(answer).toContain("Task001")
  })

  it("does not expose project details without a selected project", () => {
    const answer = buildDatabaseAssistantAnswer("查看任务", {
      ...context,
      project: null,
    })

    expect(answer).toContain("尚未选择项目")
  })

  it("maps 本月事项 queries to weekly execution items without RPMS jargon", () => {
    const answer = buildDatabaseAssistantAnswer("本月事项有哪些", context)

    expect(answer).toMatch(/本周事项|事项/)
    expect(answer).toContain("完成设计评审")
    expect(answer).not.toMatch(/备件|采购审批|必换件|选换件/)
  })

  it("returns budget and profit target facts", () => {
    const answer = buildDatabaseAssistantAnswer("预算与利润率目标", context)

    expect(answer).toContain("项目成本")
    expect(answer).toContain("1,000,000")
    expect(answer).toContain("20%")
  })

  it("refuses write intents in read-only mode", () => {
    const answer = buildDatabaseAssistantAnswer("帮我新建一个本周事项", context)

    expect(answer).toMatch(/仅支持查询|只读|不能创建|不支持修改/)
  })
})
