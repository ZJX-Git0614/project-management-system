import type { RagLiteQueryResult } from "@/lib/raglite-client"
import { assertAssistantScheduleContextV1 } from "@/lib/assistant-schedule-contract"
import {
  buildDatabaseAssistantAnswer,
  type ProjectAssistantContext,
} from "@/lib/project-assistant"

export type ProjectAssistantQueryDomain =
  | "IDENTITY"
  | "PROJECT"
  | "TASK"
  | "SCHEDULE_ANALYSIS"
  | "EARNED_VALUE"
  | "RESOURCE"
  | "SCHEDULE_COMPARE"
  | "MATTER"
  | "BUDGET"
  | "RISK"
  | "DOCUMENT"
  | "MEMBER"
  | "TODO"
  | "OPERATION"
  | "GENERAL"

export type ProjectAssistantQueryIntent = {
  domains: ProjectAssistantQueryDomain[]
  label: string
  identityOnly: boolean
}

export const PROJECT_ASSISTANT_QUERY_DOMAIN_CATALOG: Array<{
  domain: ProjectAssistantQueryDomain
  label: string
  description: string
}> = [
  { domain: "IDENTITY", label: "助手身份", description: "询问佳佳是谁、叫什么或能做什么" },
  { domain: "PROJECT", label: "项目概况", description: "项目状态、编号、客户和总体情况" },
  { domain: "TASK", label: "任务与进度", description: "甘特任务、进度、延期和计划日期" },
  { domain: "SCHEDULE_ANALYSIS", label: "计划分析", description: "基线偏差、依赖、里程碑、约束、时滞和关键路径" },
  { domain: "EARNED_VALUE", label: "挣值分析", description: "PV、EV、AC、SV、CV、SPI、CPI、EAC、ETC、VAC 和 TCPI" },
  { domain: "RESOURCE", label: "资源分析", description: "项目资源、任务分配、负荷和时间冲突" },
  { domain: "SCHEDULE_COMPARE", label: "计划对比", description: "上传进度表与当前计划或快照的差异对比" },
  { domain: "MATTER", label: "项目事项", description: "事项内容、负责人、优先级、状态和依赖" },
  { domain: "BUDGET", label: "预算与成本", description: "合同金额、预算、成本、利润率和费用" },
  { domain: "RISK", label: "风险登记", description: "风险名称、等级、状态、责任人和应对措施" },
  { domain: "DOCUMENT", label: "项目文档", description: "文档、文件、资料、报告和知识库内容" },
  { domain: "MEMBER", label: "项目成员", description: "项目组成员、角色和负责人" },
  { domain: "TODO", label: "待办事项", description: "本人待办、提醒和未完成事项" },
  { domain: "OPERATION", label: "操作记录", description: "项目操作历史和最近变更" },
  { domain: "GENERAL", label: "普通对话", description: "寒暄、感谢或不需要查询项目数据的一般问题" },
]

const DOMAIN_DEFINITION = new Map(
  PROJECT_ASSISTANT_QUERY_DOMAIN_CATALOG.map((item) => [item.domain, item]),
)

export const buildProjectAssistantQueryIntent = (
  values: unknown[],
): ProjectAssistantQueryIntent | null => {
  const domains = Array.from(new Set(values
    .map((value) => String(value || "").trim() as ProjectAssistantQueryDomain)
    .filter((value) => DOMAIN_DEFINITION.has(value))))
  if (domains.length === 0) return null
  const effectiveDomains = domains.length > 1
    ? domains.filter((domain) => domain !== "GENERAL")
    : domains
  return {
    domains: effectiveDomains,
    label: effectiveDomains
      .map((domain) => DOMAIN_DEFINITION.get(domain)?.label || domain)
      .join("、"),
    identityOnly: effectiveDomains.length === 1 && effectiveDomains[0] === "IDENTITY",
  }
}

const DOMAIN_RULES: Array<{
  domain: ProjectAssistantQueryDomain
  pattern: RegExp
}> = [
  { domain: "IDENTITY", pattern: /你是谁|你叫什么|你的名字|介绍(?:一下)?你自己|什么助手|你能做什么|你会做什么/u },
  { domain: "TASK", pattern: /任务|甘特|计划开始|计划完成|实际开始|实际完成|延期|逾期|Task\d+/iu },
  { domain: "SCHEDULE_ANALYSIS", pattern: /计划分析|关键路径|基线|里程碑|紧前|前置|依赖|时滞|\blag\b|约束(?:日期)?|计划冲突/iu },
  { domain: "EARNED_VALUE", pattern: /挣值|\bPV\b|\bEV\b|\bAC\b|\bSV\b|\bCV\b|\bSPI\b|\bCPI\b|\bEAC\b|\bETC\b|\bVAC\b|\bTCPI\b|\bBAC\b/iu },
  { domain: "RESOURCE", pattern: /资源分配|资源冲突|资源负荷|人员冲突|任务分配/u },
  { domain: "SCHEDULE_COMPARE", pattern: /进度表(?:差异|对比|比较)|计划(?:差异|对比|比较)|对比(?:当前|历史|快照)|上传计划|上传进度/u },
  { domain: "MATTER", pattern: /事项|Matter\d+|当前问题[\s/]*措施|依赖条件/iu },
  { domain: "BUDGET", pattern: /预算|成本|费用|合同金额|利润率|公摊|审价/u },
  { domain: "RISK", pattern: /风险|隐患|Risk\d+|应对措施/iu },
  { domain: "DOCUMENT", pattern: /文档|文件|资料|报告|知识库|目录/u },
  { domain: "MEMBER", pattern: /项目组|项目成员|团队成员|人员|角色|负责人/u },
  { domain: "TODO", pattern: /待办|提醒|催办|未完成的事/u },
  { domain: "OPERATION", pattern: /操作记录|操作历史|变更记录|谁改的|最近修改/u },
  { domain: "PROJECT", pattern: /项目概况|项目情况|项目状态|项目总览|项目汇总|总体情况|当前项目|项目编号|客户/u },
]

export const detectProjectAssistantQueryIntent = (
  message: string,
): ProjectAssistantQueryIntent => {
  const normalized = String(message || "").trim()
  const domains = DOMAIN_RULES
    .filter((rule) => rule.pattern.test(normalized))
    .map((rule) => rule.domain)
  return buildProjectAssistantQueryIntent(domains.length > 0 ? domains : ["GENERAL"])!
}

export const mergeProjectAssistantQueryIntents = (
  ruleIntent: ProjectAssistantQueryIntent,
  modelIntent: ProjectAssistantQueryIntent | null,
) => {
  const modelDomains = ruleIntent.identityOnly
    ? []
    : (modelIntent?.domains ?? []).filter((domain) => domain !== "IDENTITY")
  return buildProjectAssistantQueryIntent([
    ...ruleIntent.domains,
    ...modelDomains,
  ]) ?? ruleIntent
}

export const shouldPlanProjectAssistantQuery = (
  intent: ProjectAssistantQueryIntent,
  message: string,
) => {
  if (intent.identityOnly) return false
  const ordinaryConversation = /^(?:你好|您好|嗨|hi|hello|谢谢|感谢|辛苦了|再见|拜拜|你好吗|在吗)[!！。,.，？?\s]*$/iu.test(message.trim())
  if (ordinaryConversation) return false
  const followUp = /^(那|那么|这个|这些|它|它们|还有|再看|继续|刚才)/u.test(message.trim())
  return intent.domains.includes("GENERAL") || followUp
}

export const projectAssistantRagCategories = (intent: ProjectAssistantQueryIntent) => {
  const domains = new Set(intent.domains)
  const categories: string[] = []
  if (["TASK", "SCHEDULE_ANALYSIS", "EARNED_VALUE", "RESOURCE", "SCHEDULE_COMPARE"]
    .some((domain) => domains.has(domain as ProjectAssistantQueryDomain))) categories.push("project-task")
  if (domains.has("MATTER")) categories.push("weekly-item")
  if (domains.has("RISK")) categories.push("risk")
  if (domains.has("BUDGET")) categories.push("budget")
  if (domains.has("DOCUMENT")) categories.push("project-document")
  return categories
}

const scheduleHeader = (schedule: NonNullable<ProjectAssistantContext["schedule"]>) => ({
  schemaVersion: schedule.schemaVersion,
  projectId: schedule.projectId,
  statusDate: schedule.statusDate,
  source: schedule.source,
})

const scheduleTaskIdentity = (task: NonNullable<ProjectAssistantContext["schedule"]>["tasks"][number]) => ({
  id: task.id,
  parentId: task.parentId,
  taskCode: task.taskCode,
  taskName: task.taskName,
  taskCategory: task.taskCategory,
  externalUid: task.externalUid,
  wbsCode: task.wbsCode,
  outlineNumber: task.outlineNumber,
})

export const buildProjectAssistantVisibleContext = (
  context: ProjectAssistantContext,
  intent: ProjectAssistantQueryIntent,
) => {
  const domains = new Set(intent.domains)
  const base = {
    generatedAt: context.generatedAt,
    user: context.user,
  }

  if (intent.identityOnly || domains.has("GENERAL")) return base

  const visible: Record<string, unknown> = { ...base }
  if (context.project) visible.project = context.project
  const needsSchedule = ["SCHEDULE_ANALYSIS", "EARNED_VALUE", "RESOURCE", "SCHEDULE_COMPARE"]
    .some((domain) => domains.has(domain as ProjectAssistantQueryDomain))
  if (context.schedule && needsSchedule) assertAssistantScheduleContextV1(context.schedule)

  if (domains.has("PROJECT")) {
    visible.portfolio = context.portfolio
    visible.summary = {
      tasks: {
        total: context.progress.total,
        completed: context.progress.completed,
        average: context.progress.average,
        overdue: context.progress.overdue,
      },
      matters: context.weeklyItems.length,
      risks: context.risks.length,
      documents: context.documents.length,
      budget: {
        contractAmount: context.budget.contractAmount,
        total: context.budget.total,
        remaining: context.budget.remaining,
        profitTargetRate: context.budget.profitTargetRate,
      },
    }
  }
  if (domains.has("TASK")) visible.progress = context.progress
  if (context.schedule && domains.has("SCHEDULE_ANALYSIS")) {
    visible.scheduleAnalysis = {
      ...scheduleHeader(context.schedule),
      criticalPath: context.schedule.criticalPath,
      dependencies: context.schedule.dependencies,
      tasks: context.schedule.tasks.map((task) => ({
        ...scheduleTaskIdentity(task),
        startDate: task.startDate,
        finishDate: task.finishDate,
        actualStartDate: task.actualStartDate,
        actualEndDate: task.actualEndDate,
        durationDays: task.durationDays,
        durationMinutes: task.durationMinutes,
        durationFormat: task.durationFormat,
        progress: task.progress,
        taskMode: task.taskMode,
        isMilestone: task.isMilestone,
        calendarUid: task.calendarUid,
        constraintType: task.constraintType,
        constraintDate: task.constraintDate,
        baselineStartDate: task.baselineStartDate,
        baselineFinishDate: task.baselineFinishDate,
        predecessorDependencies: task.predecessorDependencies,
        successorDependencies: task.successorDependencies,
      })),
    }
  }
  if (context.schedule && domains.has("EARNED_VALUE")) {
    visible.earnedValue = {
      ...scheduleHeader(context.schedule),
      earnedValue: context.schedule.earnedValue,
      tasks: context.schedule.tasks.map((task) => ({
        ...scheduleTaskIdentity(task),
        baselineCost: task.baselineCost,
        budgetAtCompletion: task.budgetAtCompletion,
        actualCost: task.actualCost,
        progress: task.progress,
        earnedValue: task.earnedValue,
      })),
    }
  }
  if (context.schedule && domains.has("RESOURCE")) {
    visible.resources = {
      ...scheduleHeader(context.schedule),
      resources: context.schedule.resources,
      assignments: context.schedule.assignments,
      tasks: context.schedule.tasks.map((task) => ({
        ...scheduleTaskIdentity(task),
        startDate: task.startDate,
        finishDate: task.finishDate,
      })),
    }
  }
  if (context.schedule && domains.has("SCHEDULE_COMPARE")) {
    visible.scheduleCompare = {
      ...scheduleHeader(context.schedule),
      tasks: context.schedule.tasks.map((task) => ({
        ...scheduleTaskIdentity(task),
        startDate: task.startDate,
        finishDate: task.finishDate,
        actualStartDate: task.actualStartDate,
        actualEndDate: task.actualEndDate,
        durationDays: task.durationDays,
        durationMinutes: task.durationMinutes,
        progress: task.progress,
        isMilestone: task.isMilestone,
        constraintType: task.constraintType,
        constraintDate: task.constraintDate,
        baselineStartDate: task.baselineStartDate,
        baselineFinishDate: task.baselineFinishDate,
        baselineCost: task.baselineCost,
        budgetAtCompletion: task.budgetAtCompletion,
        actualCost: task.actualCost,
        predecessorDependencies: task.predecessorDependencies,
      })),
      resources: context.schedule.resources,
      assignments: context.schedule.assignments,
      comparisons: context.scheduleComparisons,
    }
  }
  if (domains.has("MATTER")) visible.matters = context.weeklyItems
  if (domains.has("BUDGET")) visible.budget = context.budget
  if (domains.has("RISK")) visible.risks = context.risks
  if (domains.has("DOCUMENT")) visible.documents = context.documents
  if (domains.has("MEMBER")) visible.members = context.members
  if (domains.has("TODO")) visible.todos = context.todos
  if (domains.has("OPERATION")) visible.recentOperations = context.recentOperations
  return visible
}

export const buildProjectAssistantFallbackAnswer = (params: {
  message: string
  intent: ProjectAssistantQueryIntent
  context: ProjectAssistantContext
  assistantName: string
}) => {
  const assistantName = params.assistantName.trim() || "佳佳"
  if (params.intent.identityOnly) {
    return {
      answer: `我是${assistantName}，Ceastar 项目管理系统的智能助手。我可以在当前账号权限范围内协助查询项目概况、任务进度、项目事项、预算成本、风险、文档、成员和待办，也可以在你确认后执行已授权操作。`,
      source: "SYSTEM" as const,
    }
  }

  if (params.intent.domains.includes("GENERAL")) {
    const message = params.message.trim()
    const answer = /^(你好|您好|嗨|hi|hello)[!！。,.，\s]*$/iu.test(message)
      ? `你好，我是${assistantName}。你可以直接告诉我想了解的项目问题。`
      : /谢谢|感谢|辛苦了/u.test(message)
        ? "不用客气。有项目问题可以继续告诉我。"
        : `我是${assistantName}。当前模型暂时没有给出有效回答，你可以换一种说法继续提问。`
    return { answer, source: "SYSTEM" as const }
  }

  return {
    answer: buildDatabaseAssistantAnswer(params.message, params.context),
    source: "DATABASE" as const,
  }
}

export const buildProjectAssistantAnswerTrace = (params: {
  intent: ProjectAssistantQueryIntent
  context: ProjectAssistantContext
  rag: RagLiteQueryResult | null
  providerName?: string | null
  modelName?: string | null
  fallbackUsed: boolean
}) => {
  const ragChunks = params.rag?.chunks ?? []
  const dataDomains = params.intent.domains.filter((domain) => !["IDENTITY", "GENERAL"].includes(domain))
  return {
    intent: params.intent.label,
    steps: [
      `识别问题范围：${params.intent.label}`,
      dataDomains.length > 0
        ? `仅加载相关业务域：${dataDomains.map((domain) => DOMAIN_DEFINITION.get(domain)?.label || domain).join("、")}`
        : "按普通对话处理，不加载项目业务明细",
      ragChunks.length > 0 ? `从项目知识库召回 ${ragChunks.length} 个相关片段` : "未使用项目知识库片段",
      params.fallbackUsed ? "模型未返回有效内容，使用确定性兜底回答" : "由佳佳根据当前问题生成回答",
    ],
    evidence: [
      ...(dataDomains.length > 0 ? [{ source: "PMS 系统数据库", detail: `实时上下文生成于 ${params.context.generatedAt}` }] : []),
      ...(ragChunks.length > 0 ? [{ source: "项目知识库", detail: `使用 ${ragChunks.length} 个相关片段` }] : []),
    ],
    provider: params.providerName ?? null,
    model: params.modelName ?? null,
    retrieved: ragChunks.slice(0, 8).map((chunk) => ({
      title: String(chunk.metadata?.fileName || chunk.metadata?.title || "知识库片段"),
      category: String(chunk.metadata?.category || ""),
    })),
    ...(dataDomains.length > 0 ? {
      dataCounts: {
        tasks: params.context.progress.total,
        weeklyItems: params.context.weeklyItems.length,
        risks: params.context.risks.length,
        documents: params.context.documents.length,
      },
    } : {}),
  }
}
