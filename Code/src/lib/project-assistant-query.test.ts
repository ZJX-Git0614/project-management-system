import { describe, expect, it } from "vitest"

import type { ProjectAssistantContext } from "@/lib/project-assistant"
import {
  buildProjectAssistantFallbackAnswer,
  buildProjectAssistantVisibleContext,
  detectProjectAssistantQueryIntent,
  projectAssistantRagCategories,
  shouldPlanProjectAssistantQuery,
} from "@/lib/project-assistant-query"

const context = {
  generatedAt: "2026-07-24T00:00:00.000Z",
  user: { id: "user-1", username: "admin", displayName: "管理员" },
  portfolio: {
    total: 1,
    statuses: { 进行中: 1 },
    projects: [{ id: "project-1", name: "示例项目", code: "P001", statusLabel: "进行中" }],
  },
  project: {
    id: "project-1",
    name: "示例项目",
    code: "P001",
    clientName: "客户A",
    statusLabel: "进行中",
  },
  members: [{ roleName: "项目经理", personName: "张三" }],
  progress: {
    total: 1,
    completed: 0,
    average: 60,
    overdue: 0,
    tasks: [{ id: "task-1", code: "Task001", name: "方案设计", progress: 60 }],
  },
  schedule: {
    schemaVersion: 1,
    projectId: "project-1",
    statusDate: "2026-07-24",
    source: { kind: "DATABASE", importedFileName: "project.xml", metadataUpdatedAt: null },
    tasks: [{
      id: "task-1",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
      projectId: "project-1",
      parentId: null,
      taskCode: "Task001",
      taskName: "方案设计",
      taskCategory: "设计",
      externalUid: "11",
      wbsCode: "1",
      outlineNumber: "1",
      startDate: "2026-07-24",
      finishDate: "2026-07-26",
      actualStartDate: "",
      actualEndDate: "",
      durationDays: 3,
      durationMinutes: 1_440,
      durationFormat: 7,
      progress: 60,
      predecessorTask: "",
      taskMode: "AUTO",
      isMilestone: false,
      calendarUid: "1",
      constraintType: null,
      constraintDate: "",
      baselineStartDate: "2026-07-24",
      baselineFinishDate: "2026-07-26",
      baselineCost: 100,
      budgetAtCompletion: 100,
      actualCost: 40,
      baselines: [{ Number: 0 }],
      sortOrder: 1,
      predecessorDependencies: [],
      successorDependencies: [],
      earnedValue: { plannedProgress: 1, pv: 100, ev: 60, sv: -40, cv: 20 },
    }],
    dependencies: [],
    resources: [{
      uid: "8",
      name: "工程师",
      type: "1",
      group: "研发",
      email: "",
      calendarUid: "1",
      maxUnits: 1,
    }],
    assignments: [{
      uid: "3",
      taskUid: "11",
      taskId: "task-1",
      resourceUid: "8",
      resourceName: "工程师",
      units: 1,
      startDate: "2026-07-24",
      finishDate: "2026-07-26",
      workMinutes: 1_440,
      actualWorkMinutes: null,
      remainingWorkMinutes: null,
    }],
    criticalPath: { status: "CALCULATED", criticalTaskIds: ["task-1"] },
    earnedValue: {
      statusDate: "2026-07-24",
      summary: {
        pv: 100,
        ev: 60,
        ac: 40,
        sv: -40,
        cv: 20,
        spi: 0.6,
        cpi: 1.5,
        bac: 100,
        typical: { etc: 26.67, eac: 66.67, vac: 33.33, tcpiEac: 1.5 },
        atypical: { etc: 40, eac: 80, vac: 20, tcpiEac: 1 },
        tcpiBac: 0.67,
      },
    },
  },
  resourceOptimization: {
    revision: 7,
    snapshotHash: "snapshot-7",
    expectedEndDate: "2026-08-20",
    conflicts: [{ id: "conflict-1", taskIds: ["task-1", "task-2"], tasks: [] }],
    candidates: [{
      kind: "FORMAL",
      title: "正式自动排期",
      applicable: true,
      changes: [{ taskId: "task-2", startDate: "2026-07-27", finishDate: "2026-07-28", task: null }],
      remainingConflicts: [],
      metrics: { movedTaskCount: 1, totalShiftDays: 2, completionDate: "2026-08-01", delayedDays: 0 },
    }],
  },
  weeklyItems: [{ id: "matter-1", code: "Matter001", title: "设计评审" }],
  budget: { contractAmount: 1_000_000, total: 300_000, remaining: 700_000, profitTargetRate: 20, categories: [] },
  risks: [{
    id: "risk-1",
    code: "Risk001",
    name: "进度风险",
    ganttTaskId: "task-1",
    weeklyItemId: "matter-1",
    ganttTask: { id: "task-1", code: "Task001", name: "方案设计" },
    weeklyItem: { id: "matter-1", code: "Matter001", title: "设计评审" },
  }],
  documents: [{ id: "document-1", name: "项目计划.docx" }],
  todos: [{ id: "todo-1", title: "完成评审" }],
  approvals: [{
    id: "approval-1",
    title: "示例项目：发布 WBS 基线",
    summary: "固化当前计划",
    status: "PENDING",
    requesterName: "李四",
    requestedAt: "2026-07-24T08:00:00.000Z",
    pendingForMe: true,
    currentNode: { name: "项目经理审批" },
  }],
  collaboration: [{
    id: "thread-1",
    title: "结构评审",
    kind: "MANUAL",
    closed: false,
    lastMessageAt: "2026-07-24T09:00:00.000Z",
    participants: [{ accountId: "user-1", displayName: "管理员" }, { accountId: "user-2", displayName: "李四" }],
    latestMessage: { senderName: "李四", content: "请确认评审结论" },
  }],
  recentOperations: [{ detail: "更新任务进度" }],
} as unknown as ProjectAssistantContext

describe("project assistant query routing", () => {
  it("routes identity questions away from project status data", () => {
    const intent = detectProjectAssistantQueryIntent("你是谁？")
    const visible = buildProjectAssistantVisibleContext(context, intent)
    const fallback = buildProjectAssistantFallbackAnswer({
      message: "你是谁？",
      intent,
      context,
      assistantName: "佳佳",
    })

    expect(intent).toMatchObject({ domains: ["IDENTITY"], identityOnly: true })
    expect(visible).toEqual({ generatedAt: context.generatedAt, user: context.user })
    expect(fallback.source).toBe("SYSTEM")
    expect(fallback.answer).toContain("我是佳佳")
    expect(fallback.answer).not.toContain("示例项目")
    expect(fallback.answer).not.toContain("进行中")
  })

  it("only exposes the business domain requested by the user", () => {
    const taskIntent = detectProjectAssistantQueryIntent("查看甘特任务进度")
    const visible = buildProjectAssistantVisibleContext(context, taskIntent) as Record<string, unknown>

    expect(taskIntent.domains).toEqual(["TASK"])
    expect(visible).toHaveProperty("project")
    expect(visible).toHaveProperty("progress")
    expect(visible).not.toHaveProperty("matters")
    expect(visible).not.toHaveProperty("budget")
    expect(visible).not.toHaveProperty("risks")
  })

  it("uses domain-specific knowledge base categories", () => {
    const intent = detectProjectAssistantQueryIntent("查看事项风险和相关文档")

    expect(intent.domains).toEqual(["MATTER", "RISK", "DOCUMENT"])
    expect(projectAssistantRagCategories(intent)).toEqual([
      "weekly-item",
      "risk",
      "project-document",
    ])
  })

  it("exposes approval and collaboration data only for their requested domains", () => {
    const approvalIntent = detectProjectAssistantQueryIntent("查看我的待审批")
    const approvalVisible = buildProjectAssistantVisibleContext(context, approvalIntent) as Record<string, unknown>
    const collaborationIntent = detectProjectAssistantQueryIntent("查看结构评审协同会话")
    const collaborationVisible = buildProjectAssistantVisibleContext(context, collaborationIntent) as Record<string, unknown>

    expect(approvalIntent.domains).toEqual(["APPROVAL"])
    expect(approvalVisible).toHaveProperty("approvals")
    expect(approvalVisible).not.toHaveProperty("collaboration")
    expect(collaborationIntent.domains).toEqual(["COLLABORATION"])
    expect(collaborationVisible).toHaveProperty("collaboration")
    expect(collaborationVisible).not.toHaveProperty("approvals")
  })

  it("routes schedule analysis, earned value, resources, and comparison separately", () => {
    expect(detectProjectAssistantQueryIntent("分析基线偏差和关键路径").domains)
      .toEqual(["SCHEDULE_ANALYSIS"])
    expect(detectProjectAssistantQueryIntent("查看 SPI 和 EAC").domains)
      .toEqual(["EARNED_VALUE"])
    expect(detectProjectAssistantQueryIntent("查看资源负荷").domains)
      .toEqual(["RESOURCE"])
    expect(detectProjectAssistantQueryIntent("给我 WBS 优化建议").domains)
      .toEqual(["RESOURCE"])
    expect(detectProjectAssistantQueryIntent("对比当前计划与上传进度").domains)
      .toEqual(["SCHEDULE_COMPARE"])
  })

  it("only exposes fields needed by each schedule domain", () => {
    const earnedValue = buildProjectAssistantVisibleContext(
      context,
      detectProjectAssistantQueryIntent("查看挣值 SPI"),
    ) as Record<string, unknown>
    const resources = buildProjectAssistantVisibleContext(
      context,
      detectProjectAssistantQueryIntent("查看资源分配"),
    ) as Record<string, unknown>

    expect(earnedValue).toHaveProperty("earnedValue")
    expect(earnedValue).not.toHaveProperty("resources")
    expect(JSON.stringify(earnedValue)).not.toContain("baselines")
    expect(resources).toHaveProperty("resources")
    expect(resources).toHaveProperty("resources.optimization")
    expect(resources).not.toHaveProperty("earnedValue")
    expect(JSON.stringify(resources)).not.toContain("actualCost")
  })

  it("returns actionable resource candidates even when the language model is unavailable", () => {
    const intent = detectProjectAssistantQueryIntent("给我 WBS 优化建议")
    const fallback = buildProjectAssistantFallbackAnswer({
      message: "给我 WBS 优化建议",
      intent,
      context,
      assistantName: "佳佳",
    })

    expect(fallback.answer).toContain("正式自动排期预览")
    expect(fallback.answer).toContain("正式自动排期")
    expect(fallback.answer).toContain("只有你确认后才写入 WBS")
  })

  it("keeps structured risk links to gantt tasks and project matters", () => {
    const visible = buildProjectAssistantVisibleContext(
      context,
      detectProjectAssistantQueryIntent("查看项目风险"),
    ) as { risks: Array<Record<string, unknown>> }

    expect(visible.risks[0]).toMatchObject({
      ganttTaskId: "task-1",
      weeklyItemId: "matter-1",
      ganttTask: { id: "task-1", code: "Task001" },
      weeklyItem: { id: "matter-1", code: "Matter001" },
    })
  })

  it("fails closed before exposing an unsupported schedule contract", () => {
    const unsupported = {
      ...context,
      schedule: { ...context.schedule, schemaVersion: 2 },
    } as unknown as ProjectAssistantContext

    expect(() => buildProjectAssistantVisibleContext(
      unsupported,
      detectProjectAssistantQueryIntent("查看挣值 SPI"),
    )).toThrow("不支持的助手计划协议版本：2")
  })

  it("keeps ordinary greetings out of the project overview fallback", () => {
    const intent = detectProjectAssistantQueryIntent("你好")
    const fallback = buildProjectAssistantFallbackAnswer({
      message: "你好",
      intent,
      context,
      assistantName: "佳佳",
    })

    expect(intent.domains).toEqual(["GENERAL"])
    expect(fallback.answer).toBe("你好，我是佳佳。你可以直接告诉我想了解的项目问题。")
    expect(fallback.answer).not.toContain("项目编号")
    expect(shouldPlanProjectAssistantQuery(intent, "你好")).toBe(false)
  })
})
