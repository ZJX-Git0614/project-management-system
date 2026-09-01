import { prisma } from "@/lib/prisma"
import type { JwtPayload } from "@/lib/auth"
import { ADMIN_ROLE_NAME } from "@/lib/permissions"
import { projectMemberAccountWhere } from "@/lib/project-member-accounts"
import { buildAssistantScheduleContextV1 } from "@/lib/assistant-schedule-adapter"
import { itemStatusFromProgress } from "@/lib/item-progress"
import {
  resourceScheduleAnalysis,
  serializeResourceCandidate,
  serializeResourceConflict,
} from "@/lib/gantt-resource-service"

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
  PENDING: "未开始",
  IN_PROGRESS: "进行中",
  DONE: "已完成",
}

const PRIORITY_LABEL: Record<string, string> = {
  LOW: "低",
  NORMAL: "普通",
  HIGH: "高",
  URGENT: "紧急",
}

const APPROVAL_STATUS_LABEL: Record<string, string> = {
  PENDING: "审批中",
  APPROVED: "已通过",
  REJECTED: "已拒绝",
  RETURNED: "已退回",
  CANCELED: "已撤销",
  COMPLETION_FAILED: "业务执行失败",
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
  user: JwtPayload & { assignedRoleNames?: string[] }
  projectId?: string | null
  includeResourceOptimization?: boolean
}) => {
  const projectId = params.projectId?.trim() || ""
  const isAdmin = (params.user.assignedRoleNames ?? []).includes(ADMIN_ROLE_NAME)
  const [projects, project, globalTodos] = await Promise.all([
    prisma.project.findMany({
      where: isAdmin
        ? undefined
        : { projectMembers: { some: projectMemberAccountWhere(params.user.userId, params.user.displayName) } },
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
            weeklyItems: {
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              include: {
                ganttTask: { select: { id: true, taskCode: true, taskName: true, parentId: true, sortOrder: true } },
                ganttTaskLinks: {
                  include: {
                    ganttTask: { select: { id: true, taskCode: true, taskName: true, parentId: true, sortOrder: true } },
                  },
                },
              },
              take: 160,
            },
            budgetCategories: {
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              include: { items: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
            },
            budgetSetting: true,
            riskRegisterItems: {
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              include: {
                ganttTask: { select: { id: true, taskCode: true, taskName: true } },
                weeklyItem: {
                  include: {
                    ganttTask: { select: { id: true, taskCode: true, taskName: true, parentId: true, sortOrder: true } },
                    ganttTaskLinks: {
                      include: {
                        ganttTask: { select: { id: true, taskCode: true, taskName: true, parentId: true, sortOrder: true } },
                      },
                    },
                  },
                },
                weeklyItemLinks: {
                  include: {
                    weeklyItem: {
                      include: {
                        ganttTask: { select: { id: true, taskCode: true, taskName: true, parentId: true, sortOrder: true } },
                        ganttTaskLinks: {
                          include: {
                            ganttTask: { select: { id: true, taskCode: true, taskName: true, parentId: true, sortOrder: true } },
                          },
                        },
                      },
                    },
                  },
                },
              },
              take: 120,
            },
            documentFiles: { orderBy: { createdAt: "desc" }, take: 120 },
            todos: { where: { status: "OPEN" }, orderBy: { createdAt: "desc" }, take: 80 },
            operationHistories: { orderBy: { createdAt: "desc" }, take: 20 },
            approvalInstances: {
              where: {
                OR: [
                  { requesterAccountId: params.user.userId },
                  { nodes: { some: { assignments: { some: { accountId: params.user.userId } } } } },
                ],
              },
              orderBy: { requestedAt: "desc" },
              take: 60,
              include: {
                nodes: {
                  orderBy: { nodeOrder: "asc" },
                  include: {
                    assignments: {
                      select: {
                        accountId: true,
                        displayNameSnapshot: true,
                        roleNameSnapshot: true,
                        status: true,
                      },
                    },
                  },
                },
                collaborationThread: { select: { id: true } },
              },
            },
            collaborationThreads: {
              where: { participants: { some: { accountId: params.user.userId } } },
              orderBy: { lastMessageAt: "desc" },
              take: 60,
              include: {
                participants: {
                  orderBy: { createdAt: "asc" },
                  select: { accountId: true, displayName: true, participantRole: true, lastReadAt: true },
                },
                messages: {
                  orderBy: { createdAt: "desc" },
                  take: 1,
                  select: { id: true, senderName: true, content: true, createdAt: true },
                },
              },
            },
          },
        })
      : Promise.resolve(null),
    prisma.todoItem.findMany({
      where: {
        status: "OPEN",
        OR: [
          { targetAccountId: params.user.userId },
          { targetAccountId: null, targetPersonName: params.user.displayName },
          { targetAccountId: null, targetPersonName: null },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { id: true, projectId: true, title: true, detail: true, type: true, targetPersonName: true },
    }),
  ])

  // Optional schedule-analysis tables may be created after the core project tables
  // during an offline Docker update. Keep the assistant usable throughout that window.
  const [scheduleMetadata, scheduleAnalyses, rawResourceOptimization] = projectId
    ? await Promise.all([
        prisma.projectScheduleImportMetadata.findUnique({ where: { projectId } }).catch(() => null),
        prisma.scheduleAnalysisRun.findMany({
          where: { projectId },
          orderBy: { createdAt: "desc" },
          take: 5,
        }).catch(() => []),
        params.includeResourceOptimization ? resourceScheduleAnalysis(projectId).catch(() => null) : Promise.resolve(null),
      ])
    : [null, [], null]

  const resourceOptimization = rawResourceOptimization
    ? {
        revision: rawResourceOptimization.context.currentProject.ganttRevision,
        snapshotHash: rawResourceOptimization.result.snapshotHash,
        expectedEndDate: rawResourceOptimization.context.currentProject.expectedEndDate,
        conflicts: rawResourceOptimization.result.conflicts.map((conflict) => (
          serializeResourceConflict(conflict, rawResourceOptimization.context.summaries, isAdmin)
        )),
        candidates: rawResourceOptimization.result.candidates.map((candidate) => (
          serializeResourceCandidate(candidate, rawResourceOptimization.context.summaries, isAdmin)
        )),
      }
    : null

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
    earlyStart: task.earlyStartDate,
    earlyFinish: task.earlyFinishDate,
    lateStart: task.lateStartDate,
    lateFinish: task.lateFinishDate,
    totalFloatMinutes: task.totalFloatMinutes,
    freeFloatMinutes: task.freeFloatMinutes,
    scheduleStatus: task.scheduleStatus,
    actualStart: task.actualStartDate,
    actualEnd: task.actualEndDate,
    progress: task.progress,
    externalUid: task.externalUid,
    wbsCode: task.wbsCode,
    outlineNumber: task.outlineNumber,
    isMilestone: task.isMilestone,
  }))
  const overdueTasks = tasks.filter((task) => task.progress < 100 && task.plannedEnd && task.plannedEnd < statusDate)
  const visibleProjectTodos = (project?.todos ?? []).filter((todo) => (
    todo.targetAccountId
      ? todo.targetAccountId === params.user.userId
      : !todo.targetPersonName || todo.targetPersonName === params.user.displayName
  ))
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
    resourceOptimization,
    scheduleComparisons,
    weeklyItems: (project?.weeklyItems ?? []).map((item) => {
      const linkedTasks = item.ganttTaskLinks.length > 0
        ? item.ganttTaskLinks.map((link) => link.ganttTask)
        : item.ganttTask ? [item.ganttTask] : [];
      linkedTasks.sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
      return {
        id: item.id,
        code: item.matterCode,
        title: item.title,
        ganttTaskId: linkedTasks[0]?.id ?? null,
        ganttTaskIds: linkedTasks.map((task) => task.id),
        taskName: linkedTasks.map((task) => task.taskName).join("、"),
        linkedTasks: linkedTasks.map((task) => ({ id: task.id, code: task.taskCode, name: task.taskName })),
        owner: item.owner,
        priority: PRIORITY_LABEL[item.priority] || item.priority,
        status: ITEM_STATUS_LABEL[itemStatusFromProgress(item.progress)],
        plannedStart: item.plannedStartDate,
        plannedEnd: item.plannedEndDate,
        actualStart: item.actualStartDate,
        actualEnd: item.actualEndDate,
        progress: item.progress,
        health: item.health,
        issueAndAction: item.issueAndAction,
        risk: item.risk,
      };
    }),
    budget: {
      contractAmount,
      profitTargetRate: project?.budgetSetting?.profitTargetRate ?? 0,
      total: totalBudget,
      remaining: contractAmount - totalBudget,
      categories: budgetCategories,
    },
    risks: (project?.riskRegisterItems ?? []).map((risk) => {
      const linkedItems = risk.weeklyItemLinks.length > 0
        ? risk.weeklyItemLinks.map((link) => link.weeklyItem)
        : risk.weeklyItem ? [risk.weeklyItem] : [];
      const affectedTaskById = new Map<string, {
        id: string;
        taskCode: string;
        taskName: string;
        sortOrder: number;
      }>();
      linkedItems.forEach((item) => {
        const linkedTasks = item.ganttTaskLinks.length > 0
          ? item.ganttTaskLinks.map((link) => link.ganttTask)
          : item.ganttTask ? [item.ganttTask] : [];
        linkedTasks.forEach((task) => affectedTaskById.set(task.id, task));
      });
      const affectedTasks = [...affectedTaskById.values()]
        .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
      return {
        id: risk.id,
        code: risk.riskCode,
        name: risk.riskName,
        ganttTaskId: null,
        weeklyItemId: linkedItems[0]?.id ?? null,
        weeklyItemIds: linkedItems.map((item) => item.id),
        linkedItem: linkedItems.map((item) => `${item.matterCode} · ${item.title}`).join("、"),
        linkedTask: affectedTasks.map((task) => `${task.taskCode} · ${task.taskName}`).join("、"),
        linkedItems: linkedItems.map((item) => ({ id: item.id, code: item.matterCode, title: item.title })),
        affectedTasks: affectedTasks.map((task) => ({ id: task.id, code: task.taskCode, name: task.taskName })),
        category: risk.category,
        probability: risk.probability,
        impact: risk.impact,
        level: risk.level,
        response: risk.response,
        owner: risk.owner,
        status: risk.status,
        targetDate: risk.targetDate,
      };
    }),
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
    approvals: (project?.approvalInstances ?? []).map((instance) => {
      const currentNode = instance.nodes.find((node) => node.status === "PENDING") ?? null
      const pendingAssignments = currentNode?.assignments.filter((assignment) => assignment.status === "PENDING") ?? []
      return {
        id: instance.id,
        businessType: instance.businessType,
        businessId: instance.businessId,
        title: instance.title,
        summary: instance.summary,
        status: instance.status,
        requesterAccountId: instance.requesterAccountId,
        requesterName: instance.requesterName,
        requestedAt: instance.requestedAt.toISOString(),
        completedAt: instance.completedAt?.toISOString() ?? null,
        currentNode: currentNode
          ? {
              id: currentNode.id,
              name: currentNode.nodeName,
              order: currentNode.nodeOrder,
              assignments: pendingAssignments.map((assignment) => ({
                accountId: assignment.accountId,
                displayName: assignment.displayNameSnapshot,
                roleName: assignment.roleNameSnapshot,
              })),
            }
          : null,
        requestedByMe: instance.requesterAccountId === params.user.userId,
        pendingForMe: pendingAssignments.some((assignment) => assignment.accountId === params.user.userId),
        collaborationThreadId: instance.collaborationThread?.id ?? null,
      }
    }),
    collaboration: (project?.collaborationThreads ?? []).map((thread) => ({
      id: thread.id,
      title: thread.title,
      kind: thread.kind,
      entityType: thread.entityType,
      entityId: thread.entityId,
      closed: Boolean(thread.closedAt),
      lastMessageAt: thread.lastMessageAt.toISOString(),
      participants: thread.participants.map((participant) => ({
        accountId: participant.accountId,
        displayName: participant.displayName,
        role: participant.participantRole,
        lastReadAt: participant.lastReadAt?.toISOString() ?? null,
      })),
      latestMessage: thread.messages[0]
        ? {
            id: thread.messages[0].id,
            senderName: thread.messages[0].senderName,
            content: thread.messages[0].content,
            createdAt: thread.messages[0].createdAt.toISOString(),
          }
        : null,
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
  const approvals = context.approvals ?? []
  const collaboration = context.collaboration ?? []

  context.progress.tasks.forEach((task) => {
    if (includes(task.code, task.name, task.category, task.wbsCode, task.outlineNumber, task.externalUid)
      || (task.isMilestone && includes("里程碑"))) {
      const floatDetail = task.totalFloatMinutes == null ? "" : ` · 总浮动 ${Math.round(task.totalFloatMinutes / 450 * 100) / 100} 天`
      results.push({ type: "任务", title: `${task.code} ${task.name}`, detail: `进度 ${task.progress}% · ${task.plannedStart || "未定"} 至 ${task.plannedEnd || "未定"}${floatDetail}` })
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
  approvals.forEach((approval) => {
    if (includes(approval.title, approval.summary, approval.status, approval.requesterName, approval.currentNode?.name)) {
      results.push({
        type: "审批",
        title: approval.title,
        detail: `${approval.status} · ${approval.currentNode?.name || "已结束"} · 发起人 ${approval.requesterName}`,
      })
    }
  })
  collaboration.forEach((thread) => {
    if (includes(thread.title, thread.kind, thread.latestMessage?.content, ...thread.participants.map((participant) => participant.displayName))) {
      results.push({
        type: "协同",
        title: thread.title,
        detail: `${thread.closed ? "已关闭" : "进行中"} · ${thread.participants.length} 人 · ${thread.latestMessage?.content || "暂无消息"}`,
      })
    }
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
  "当前数据库问答层仅支持查询，不能直接创建、修改或删除数据。",
  "如需写入，请明确对象、目标值和必要原因；佳佳会先安全定位操作对象并展示确认卡片，确认后再按权限执行。",
].join("\n\n")

export const buildDatabaseAssistantAnswer = (query: string, context: ProjectAssistantContext) => {
  const text = query.toLowerCase()
  const compactText = text.replace(/\s+/g, "")
  const project = context.project
  const approvals = context.approvals ?? []
  const collaboration = context.collaboration ?? []
  const asks = (keywords: string[]) => keywords.some((keyword) => {
    const normalizedKeyword = keyword.toLowerCase()
    return text.includes(normalizedKeyword) || compactText.includes(normalizedKeyword.replace(/\s+/g, ""))
  })

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

  if (asks(["资源冲突", "人员冲突", "资源优化", "资源排期", "排期优化", "自动排期", "正式排期", "wbs优化", "优化wbs"])) {
    const optimization = context.resourceOptimization
    if (!optimization) return "当前未生成正式自动排期预览，请刷新后重试。"
    if (optimization.conflicts.length === 0) {
      return "## 正式自动排期\n\n当前负责人任务时间范围内未检测到资源冲突。仍可执行正式自动排期，由系统按 T0、FS 紧前关系、日历、负责人容量和硬边界重新计算未开始叶子任务。"
    }
    return [
      "## 正式自动排期预览",
      `当前检测到 **${optimization.conflicts.length}** 组负责人时间冲突。正式算法只调整当前项目范围内未开始、可排程的叶子任务；它会先按 T0、FS 紧前关系、日历和硬边界计算网络浮动，再按负责人容量、下游影响与任务优先级安排。日期固定、进行中、已完成和范围外任务保持不变。`,
      markdownTable(
        ["正式方案", "调整任务", "累计移动", "预计完成", "剩余冲突", "可应用"],
        optimization.candidates.map((candidate) => [
          candidate.title,
          candidate.metrics.movedTaskCount,
          `${candidate.metrics.totalShiftDays} 天`,
          candidate.metrics.completionDate || "未确定",
          candidate.remainingConflicts.length,
          candidate.applicable ? "是" : "否",
        ]),
      ),
      "你可以继续说“执行正式自动排期”或“应用自动排期”。我会先展示确认卡片，只有你确认后才写入 WBS；如果期间 WBS 已变化，旧预览会自动失效。",
    ].join("\n\n")
  }

  if (asks(["审批", "审核", "待我审批", "我发起的审批", "流程状态"])) {
    const onlyPendingForMe = asks(["待我审批", "我的待审批", "需要我审批"])
    const visibleApprovals = onlyPendingForMe
      ? approvals.filter((approval) => approval.pendingForMe)
      : approvals
    return [
      "## 项目审批",
      onlyPendingForMe
        ? `当前有 **${visibleApprovals.length}** 条审批等待你处理。`
        : `当前账号可见 **${visibleApprovals.length}** 条项目审批，其中待本人处理 **${approvals.filter((approval) => approval.pendingForMe).length}** 条。`,
      markdownTable(
        ["审批标题", "状态", "当前节点", "发起人", "发起时间"],
        visibleApprovals.slice(0, 20).map((approval) => [
          approval.title,
          APPROVAL_STATUS_LABEL[approval.status] || approval.status,
          approval.currentNode?.name || "-",
          approval.requesterName,
          approval.requestedAt.slice(0, 16).replace("T", " "),
        ]),
      ),
      visibleApprovals.some((approval) => approval.pendingForMe)
        ? "你可以明确说“同意审批《审批标题》”，或在拒绝、退回时同时给出原因。佳佳只会处理能唯一定位且确实分配给你的审批。"
        : "当前没有分配给你的待处理审批。",
    ].join("\n\n")
  }

  if (asks(["协同", "会话", "项目沟通", "讨论", "消息", "提及"])) {
    return [
      "## 项目协同会话",
      `当前账号可访问 **${collaboration.length}** 个项目协同会话。`,
      markdownTable(
        ["会话", "状态", "参与人", "最近消息", "更新时间"],
        collaboration.slice(0, 20).map((thread) => [
          thread.title,
          thread.closed ? "已关闭" : "进行中",
          thread.participants.map((participant) => participant.displayName).join("、"),
          thread.latestMessage ? `${thread.latestMessage.senderName}：${thread.latestMessage.content}` : "暂无消息",
          thread.lastMessageAt.slice(0, 16).replace("T", " "),
        ]),
      ),
      "需要发送消息时，请明确会话名称和消息内容；佳佳只会向你已参与且未关闭的唯一会话发送。",
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
      `- 审批：${approvals.length} 条，其中待本人处理 ${approvals.filter((approval) => approval.pendingForMe).length} 条`,
      `- 协同会话：${collaboration.length} 个`,
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
    "你可以继续询问：项目总体情况、任务进度与延期、项目事项、成本执行、项目风险、文档清单、项目成员、待办、审批或协同会话。",
  ].join("\n\n")
}
