import { prisma } from "@/lib/prisma"
import type { JwtPayload } from "@/lib/auth"
import { buildAssistantScheduleContextV1 } from "@/lib/assistant-schedule-adapter"

export type AssistantMessageInput = {
  role: "user" | "assistant"
  content: string
}

export type ProjectAssistantContext = Awaited<ReturnType<typeof buildProjectAssistantContext>>

const PROJECT_STATUS_LABEL: Record<string, string> = {
  DRAFT: "草稿",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  VOIDED: "已作废",
}

const ITEM_STATUS_LABEL: Record<string, string> = {
  PENDING: "待开始",
  IN_PROGRESS: "进行中",
  DONE: "已完成",
  CANCELED: "已取消",
}

const PRIORITY_LABEL: Record<string, string> = {
  LOW: "低",
  NORMAL: "普通",
  HIGH: "高",
  URGENT: "紧急",
}

const addDays = (date: string, days: number) => {
  if (!date) return ""
  const value = new Date(`${date}T00:00:00`)
  if (Number.isNaN(value.getTime())) return ""
  value.setDate(value.getDate() + Math.max(0, days - 1))
  return value.toISOString().slice(0, 10)
}

const itemAmount = (item: {
  personMonths: number
  monthlyCostPerPerson: number
  unitPrice: number
  sampleQuantity: number
  productionQuantity: number
  amount: number
  currentRate: number
}, kind: string, contractAmount: number) => {
  if (kind === "MANPOWER") return item.personMonths * item.monthlyCostPerPerson
  if (kind === "PURCHASE") return item.unitPrice * (item.sampleQuantity + item.productionQuantity)
  if (kind === "RATE") return contractAmount * item.currentRate / 100
  return item.amount
}

const escapeCell = (value: unknown) => String(value ?? "-").replaceAll("|", "\\|").replaceAll("\n", " ")

const markdownTable = (headers: string[], rows: unknown[][]) => {
  if (rows.length === 0) return "暂无记录。"
  return [
    `| ${headers.map(escapeCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ].join("\n")
}

export const buildProjectAssistantContext = async (params: {
  user: JwtPayload
  projectId?: string | null
}) => {
  const projectId = params.projectId?.trim() || ""
  const [projects, project, globalTodos] = await Promise.all([
    prisma.project.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        name: true,
        code: true,
        clientName: true,
        amountWan: true,
        status: true,
        startDate: true,
        expectedEndDate: true,
      },
    }),
    projectId
      ? prisma.project.findUnique({
          where: { id: projectId },
          include: {
            projectMembers: { orderBy: [{ roleName: "asc" }, { personName: "asc" }] },
            ganttTasks: {
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              include: {
                predecessorDependencies: {
                  orderBy: { createdAt: "asc" },
                  include: {
                    predecessorTask: {
                      select: { id: true, taskCode: true, taskName: true },
                    },
                  },
                },
              },
            },
            weeklyItems: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], take: 160 },
            budgetCategories: {
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              include: { items: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
            },
            budgetSetting: true,
            riskRegisterItems: {
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              include: {
                ganttTask: { select: { id: true, taskCode: true, taskName: true } },
                weeklyItem: { select: { id: true, matterCode: true, title: true } },
              },
              take: 120,
            },
            documentFiles: { orderBy: { createdAt: "desc" }, take: 120 },
            todos: { where: { status: "OPEN" }, orderBy: { createdAt: "desc" }, take: 80 },
            operationHistories: { orderBy: { createdAt: "desc" }, take: 20 },
          },
        })
      : Promise.resolve(null),
    prisma.todoItem.findMany({
      where: {
        status: "OPEN",
        OR: [
          { targetPersonName: params.user.displayName },
          { targetPersonName: null },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { id: true, projectId: true, title: true, detail: true, type: true, targetPersonName: true },
    }),
  ])

  // Optional schedule-analysis tables may be created after the core project tables
  // during an offline Docker update. Keep the assistant usable throughout that window.
  const [scheduleMetadata, scheduleAnalyses] = projectId
    ? await Promise.all([
        prisma.projectScheduleImportMetadata.findUnique({ where: { projectId } }).catch(() => null),
        prisma.scheduleAnalysisRun.findMany({
          where: { projectId },
          orderBy: { createdAt: "desc" },
          take: 5,
        }).catch(() => []),
      ])
    : [null, []]

  const contractAmount = project?.budgetSetting?.contractAmount ?? (project?.amountWan ?? 0) * 10_000
  const budgetCategories = (project?.budgetCategories ?? []).map((category) => {
    const items = category.items.map((item) => ({
      id: item.id,
      title: item.title || item.groupName || category.name,
      person: item.person,
      remark: item.remark,
      currentRate: item.currentRate,
      subtotal: itemAmount(item, category.kind, contractAmount),
    }))
    return {
      id: category.id,
      name: category.name,
      kind: category.kind,
      subtotal: items.reduce((sum, item) => sum + item.subtotal, 0),
      items,
    }
  })
  const totalBudget = budgetCategories.reduce((sum, category) => sum + category.subtotal, 0)
  const generatedAt = new Date().toISOString()
  const statusDate = generatedAt.slice(0, 10)
  const schedule = project
    ? buildAssistantScheduleContextV1({
        projectId: project.id,
        statusDate,
        tasks: project.ganttTasks,
        metadata: scheduleMetadata,
      })
    : null
  const tasks = (schedule?.tasks ?? []).map((task) => ({
    id: task.id,
    code: task.taskCode,
    category: task.taskCategory,
    name: task.taskName,
    plannedStart: task.startDate,
    plannedEnd: task.finishDate || addDays(task.startDate, task.durationDays),
    actualStart: task.actualStartDate,
    actualEnd: task.actualEndDate,
    progress: task.progress,
    externalUid: task.externalUid,
    wbsCode: task.wbsCode,
    outlineNumber: task.outlineNumber,
    isMilestone: task.isMilestone,
  }))
  const overdueTasks = tasks.filter((task) => task.progress < 100 && task.plannedEnd && task.plannedEnd < statusDate)
  const visibleProjectTodos = (project?.todos ?? []).filter((todo) =>
    !todo.targetPersonName || todo.targetPersonName === params.user.displayName)
  const scheduleComparisons = scheduleAnalyses.map((run) => {
    try {
      const result = JSON.parse(run.resultJson || "{}")
      return {
        id: run.id,
        sourceFileName: run.sourceFileName,
        statusDate: run.statusDate,
        status: run.status,
        createdAt: run.createdAt.toISOString(),
        summary: result.summary ?? {},
        changes: Array.isArray(result.changes) ? result.changes.slice(0, 300) : [],
        issues: Array.isArray(result.issues) ? result.issues.slice(0, 300) : [],
      }
    } catch {
      return {
        id: run.id,
        sourceFileName: run.sourceFileName,
        statusDate: run.statusDate,
        status: "INVALID",
        createdAt: run.createdAt.toISOString(),
        summary: {},
        changes: [],
        issues: [],
      }
    }
  })

  return {
    generatedAt,
    user: {
      id: params.user.userId,
      username: params.user.username,
      displayName: params.user.displayName,
    },
    portfolio: {
      total: projects.length,
      statuses: projects.reduce<Record<string, number>>((result, item) => {
        const label = PROJECT_STATUS_LABEL[item.status] || item.status
        result[label] = (result[label] ?? 0) + 1
        return result
      }, {}),
      projects: projects.map((item) => ({
        ...item,
        statusLabel: PROJECT_STATUS_LABEL[item.status] || item.status,
      })),
    },
    project: project
      ? {
          id: project.id,
          name: project.name,
          code: project.code,
          clientName: project.clientName,
          amountWan: project.amountWan,
          deviceCount: project.deviceCount,
          startDate: project.startDate,
          expectedEndDate: project.expectedEndDate,
          status: project.status,
          statusLabel: PROJECT_STATUS_LABEL[project.status] || project.status,
        }
      : null,
    members: (project?.projectMembers ?? []).map((member) => ({
      roleName: member.roleName,
      personName: member.personName,
    })),
    progress: {
      total: tasks.length,
      completed: tasks.filter((task) => task.progress >= 100).length,
      average: tasks.length > 0
        ? Math.round(tasks.reduce((sum, task) => sum + task.progress, 0) / tasks.length)
        : 0,
      overdue: overdueTasks.length,
      tasks,
    },
    schedule,
    scheduleComparisons,
    weeklyItems: (project?.weeklyItems ?? []).map((item) => ({
      id: item.id,
      code: item.matterCode,
      title: item.title,
      ganttTaskId: item.ganttTaskId,
      taskName: item.taskName,
      owner: item.owner,
      priority: PRIORITY_LABEL[item.priority] || item.priority,
      status: ITEM_STATUS_LABEL[item.status] || item.status,
      plannedStart: item.plannedStartDate,
      plannedEnd: item.plannedEndDate,
      actualStart: item.actualStartDate,
      actualEnd: item.actualEndDate,
      progress: item.progress,
      health: item.health,
      issueAndAction: item.issueAndAction,
      risk: item.risk,
    })),
    budget: {
      contractAmount,
      profitTargetRate: project?.budgetSetting?.profitTargetRate ?? 0,
      total: totalBudget,
      remaining: contractAmount - totalBudget,
      categories: budgetCategories,
    },
    risks: (project?.riskRegisterItems ?? []).map((risk) => ({
      id: risk.id,
      code: risk.riskCode,
      name: risk.riskName,
      ganttTaskId: risk.ganttTaskId,
      weeklyItemId: risk.weeklyItemId,
      linkedTask: risk.ganttTask
        ? [risk.ganttTask.taskCode, risk.ganttTask.taskName].filter(Boolean).join(" · ")
        : "",
      ganttTask: risk.ganttTask
        ? { id: risk.ganttTask.id, code: risk.ganttTask.taskCode, name: risk.ganttTask.taskName }
        : null,
      linkedItem: risk.weeklyItem
        ? [risk.weeklyItem.matterCode, risk.weeklyItem.title].filter(Boolean).join(" · ")
        : risk.linkedItemName,
      weeklyItem: risk.weeklyItem
        ? { id: risk.weeklyItem.id, code: risk.weeklyItem.matterCode, title: risk.weeklyItem.title }
        : null,
      category: risk.category,
      probability: risk.probability,
      impact: risk.impact,
      level: risk.level,
      response: risk.response,
      owner: risk.owner,
      status: risk.status,
      targetDate: risk.targetDate,
    })),
    documents: (project?.documentFiles ?? []).map((document) => ({
      id: document.id,
      directoryKey: document.directoryKey,
      name: document.originalName,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      uploadedBy: document.uploadedBy,
      createdAt: document.createdAt.toISOString(),
    })),
    todos: (project ? visibleProjectTodos : globalTodos).map((todo) => ({
      id: todo.id,
      projectId: todo.projectId,
      title: todo.title,
      detail: todo.detail,
      type: todo.type,
      targetPersonName: todo.targetPersonName,
    })),
    recentOperations: (project?.operationHistories ?? []).map((history) => ({
      detail: history.detail,
      operator: history.operator,
      actionType: history.actionType,
      createdAt: history.createdAt.toISOString(),
    })),
  }
}

const searchContext = (query: string, context: ProjectAssistantContext) => {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return []
  const includes = (...values: unknown[]) => values.some((value) => String(value ?? "").toLowerCase().includes(keyword))
  const results: Array<{ type: string; title: string; detail: string }> = []

  context.progress.tasks.forEach((task) => {
    if (includes(task.code, task.name, task.category, task.wbsCode, task.outlineNumber, task.externalUid)
      || (task.isMilestone && includes("里程碑"))) {
      results.push({ type: "任务", title: `${task.code} ${task.name}`, detail: `进度 ${task.progress}% · ${task.plannedStart || "未定"} 至 ${task.plannedEnd || "未定"}` })
    }
  })
  context.weeklyItems.forEach((item) => {
    if (includes(item.code, item.title, item.taskName, item.owner, item.issueAndAction)) {
      results.push({ type: "事项", title: `${item.code} ${item.title}`, detail: `${item.owner || "未分配"} · ${item.status} · 进度 ${item.progress}%` })
    }
  })
  context.risks.forEach((risk) => {
    if (includes(risk.code, risk.name, risk.linkedItem, risk.category, risk.owner, risk.response)) {
      results.push({ type: "风险", title: `${risk.code} ${risk.name}`, detail: `${risk.level} · ${risk.status} · ${risk.owner || "未分配"}` })
    }
  })
  context.documents.forEach((document) => {
    if (includes(document.name, document.directoryKey, document.uploadedBy)) {
      results.push({ type: "文档", title: document.name, detail: `${document.directoryKey} · ${document.uploadedBy}` })
    }
  })
  context.members.forEach((member) => {
    if (includes(member.personName, member.roleName)) {
      results.push({ type: "成员", title: member.personName, detail: member.roleName })
    }
  })
  context.budget.categories.forEach((category) => {
    category.items.forEach((item) => {
      if (includes(category.name, item.title, item.person, item.remark)) {
        results.push({ type: "成本", title: item.title, detail: `${category.name} · ¥${item.subtotal.toLocaleString("zh-CN")}` })
      }
    })
  })
  return results.slice(0, 20)
}

const WRITE_INTENT_KEYWORDS = [
  "新建", "创建", "新增", "删除", "移除", "修改", "更新", "编辑", "作废", "恢复",
  "帮我写", "帮我改", "提交审批", "通过审批", "驳回",
]

const isWriteIntent = (text: string) =>
  WRITE_INTENT_KEYWORDS.some((keyword) => text.includes(keyword))
  && !text.includes("查看")
  && !text.includes("查询")
  && !text.includes("哪些")
  && !text.includes("多少")

const READ_ONLY_REFUSAL = [
  "当前版本的佳佳**仅支持查询**，不能创建、修改或删除数据。",
  "你可以直接问我：项目概况、任务/甘特进度、项目事项、预算与利润率、成员、待办或风险。",
].join("\n\n")

export const buildDatabaseAssistantAnswer = (query: string, context: ProjectAssistantContext) => {
  const text = query.toLowerCase()
  const project = context.project
  const asks = (keywords: string[]) => keywords.some((keyword) => text.includes(keyword))

  if (isWriteIntent(query)) return READ_ONLY_REFUSAL

  if (!project) {
    if (asks(["待办", "需要做", "未完成"])) {
      const projectNameById = new Map(context.portfolio.projects.map((item) => [item.id, item.name]))
      return [
        "## 我的待办",
        markdownTable(
          ["项目", "待办", "说明"],
          context.todos.slice(0, 20).map((todo) => [projectNameById.get(todo.projectId) || "-", todo.title, todo.detail || "-"]),
        ),
      ].join("\n\n")
    }
    if (asks(["当前项目", "任务", "事项", "预算", "成本", "风险", "文档", "成员", "甘特"])) {
      return "当前尚未选择项目。请先从项目列表进入一个项目，我就能基于该项目的任务、事项、预算、风险和文档进行查询。"
    }
    return [
      "## 项目组合概况",
      `当前共有 **${context.portfolio.total}** 个项目。${Object.entries(context.portfolio.statuses).map(([status, count]) => `${status} ${count} 个`).join("，")}。`,
      markdownTable(
        ["项目编号", "项目名称", "客户", "状态"],
        context.portfolio.projects.slice(0, 12).map((item) => [item.code || "-", item.name, item.clientName || "-", item.statusLabel]),
      ),
    ].join("\n\n")
  }

  if (asks(["任务", "甘特", "进度", "延期", "逾期"])) {
    const tasks = asks(["延期", "逾期"])
      ? context.progress.tasks.filter((task) => task.progress < 100 && task.plannedEnd && task.plannedEnd < new Date().toISOString().slice(0, 10))
      : context.progress.tasks
    return [
      "## 任务进度",
      `共 **${context.progress.total}** 个任务，已完成 **${context.progress.completed}** 个，平均进度 **${context.progress.average}%**，延期 **${context.progress.overdue}** 个。`,
      markdownTable(
        ["任务ID", "任务名称", "计划完成", "进度"],
        tasks.slice(0, 18).map((task) => [task.code, task.name, task.plannedEnd || "未设置", `${task.progress}%`]),
      ),
    ].join("\n\n")
  }

  if (asks(["事项", "本周", "本月", "月度", "责任人", "优先级"])) {
    return [
      "## 项目事项",
      `当前项目共有 **${context.weeklyItems.length}** 条事项。`,
      markdownTable(
        ["事项ID", "事项名称", "责任人", "优先级", "状态", "进度"],
        context.weeklyItems.slice(0, 20).map((item) => [item.code, item.title, item.owner || "未分配", item.priority, item.status, `${item.progress}%`]),
      ),
    ].join("\n\n")
  }

  if (asks(["预算", "成本", "费用", "利润", "合同"])) {
    return [
      "## 项目成本",
      `合同金额 **¥${context.budget.contractAmount.toLocaleString("zh-CN")}**，当前预算 **¥${context.budget.total.toLocaleString("zh-CN")}**，剩余额度 **¥${context.budget.remaining.toLocaleString("zh-CN")}**，目标利润率 **${context.budget.profitTargetRate}%**。`,
      markdownTable(
        ["成本分类", "类型", "小计"],
        context.budget.categories.map((category) => [category.name, category.kind, `¥${category.subtotal.toLocaleString("zh-CN")}`]),
      ),
    ].join("\n\n")
  }

  if (asks(["风险", "问题", "隐患"])) {
    return [
      "## 项目风险",
      `当前登记 **${context.risks.length}** 条风险。`,
      markdownTable(
        ["风险ID", "风险名称", "关联事项", "等级", "状态", "责任人", "目标日期"],
        context.risks.slice(0, 20).map((risk) => [risk.code, risk.name, risk.linkedItem || "未关联", risk.level, risk.status, risk.owner || "未分配", risk.targetDate || "未设置"]),
      ),
    ].join("\n\n")
  }

  if (asks(["文档", "文件", "资料", "报告"])) {
    return [
      "## 项目文档",
      `当前已上传 **${context.documents.length}** 个文件。`,
      markdownTable(
        ["文件名称", "所属目录", "上传人", "上传时间"],
        context.documents.slice(0, 20).map((document) => [document.name, document.directoryKey, document.uploadedBy, document.createdAt.slice(0, 10)]),
      ),
    ].join("\n\n")
  }

  if (asks(["成员", "项目组", "人员", "负责人"])) {
    return [
      "## 项目成员",
      markdownTable(["角色", "人员"], context.members.map((member) => [member.roleName, member.personName])),
    ].join("\n\n")
  }

  if (asks(["待办", "需要做", "未完成"])) {
    return [
      "## 当前待办",
      markdownTable(["待办", "说明"], context.todos.slice(0, 20).map((todo) => [todo.title, todo.detail || "-"])),
    ].join("\n\n")
  }

  if (asks(["概况", "总览", "汇总", "总体", "项目情况"])) {
    return [
      `## ${project.name}`,
      `项目编号 **${project.code || "-"}**，客户 **${project.clientName || "-"}**，当前状态 **${project.statusLabel}**。`,
      `- 任务：${context.progress.total} 个，平均进度 ${context.progress.average}%，延期 ${context.progress.overdue} 个`,
      `- 事项：${context.weeklyItems.length} 条`,
      `- 风险：${context.risks.length} 条`,
      `- 文档：${context.documents.length} 个`,
      `- 预算：¥${context.budget.total.toLocaleString("zh-CN")} / 合同金额 ¥${context.budget.contractAmount.toLocaleString("zh-CN")}`,
    ].join("\n\n")
  }

  const searchResults = searchContext(query, context)
  if (searchResults.length > 0) {
    return [
      `## “${query}”的项目内搜索结果`,
      markdownTable(["类型", "名称", "详情"], searchResults.map((item) => [item.type, item.title, item.detail])),
    ].join("\n\n")
  }

  return [
    "当前项目数据中没有找到直接匹配的记录。",
    "你可以继续询问：项目总体情况、任务进度与延期、项目事项、成本执行、项目风险、文档清单、项目成员或待办。",
  ].join("\n\n")
}
