import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized } from "@/lib/api-utils"
import { ItemStatus } from "@/domain/enums"
import { nextWeeklyMatterCode, renumberWeeklyMatterCodesByProject } from "@/lib/weekly-matter-codes"

const SERIALIZE_KEYS = [
  "id", "projectId", "matterCode", "sortOrder", "title", "ganttTaskId", "taskName", "description", "dueDate", "status", "owner", "priority",
  "plannedStartDate", "actualStartDate", "plannedEndDate", "actualEndDate",
  "progress", "health", "issueAndAction", "dependency", "risk", "riskStatus", "remark",
] as const

const LINKED_RISK_SELECT = {
  id: true,
  riskCode: true,
  riskName: true,
  weeklyItemId: true,
  category: true,
  trigger: true,
  probability: true,
  impact: true,
  level: true,
  response: true,
  owner: true,
  status: true,
  targetDate: true,
} as const

function serializeItem(item: Record<string, unknown>) {
  const out: Record<string, unknown> = { project: (item as { project?: unknown }).project }
  for (const k of SERIALIZE_KEYS) {
    out[k] = item[k]
  }
  const linkedTask = item.ganttTask as { taskName?: string } | null | undefined
  out.ganttTaskId = item.ganttTaskId ?? null
  out.taskName = linkedTask?.taskName ?? item.taskName ?? ""
  out.linkedRisks = ((item.riskItems as Array<Record<string, unknown>> | undefined) ?? []).map((risk) => ({
    ...risk,
    linkedItemCode: item.matterCode ?? "",
    linkedItemName: item.title ?? "",
  }))
  out.createdAt = (item.createdAt as Date).toISOString()
  out.updatedAt = (item.updatedAt as Date).toISOString()
  return out
}

const EXTRA_FIELDS: readonly string[] = [
  "plannedStartDate", "actualStartDate", "plannedEndDate", "actualEndDate",
  "progress", "health", "issueAndAction", "dependency", "remark",
]

function buildExtraData(body: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const k of EXTRA_FIELDS) {
    if (body[k] !== undefined) data[k] = body[k]
  }
  return data
}

async function normalizeWeeklyMatterCodes<T extends { id: string; projectId: string; matterCode: string; sortOrder?: number; createdAt: Date | string }>(items: T[]) {
  const codedItems = renumberWeeklyMatterCodesByProject(items)
  await Promise.all(
    codedItems
      .filter((item, index) => item.matterCode !== items[index].matterCode)
      .map((item) => prisma.weeklyItem.update({
        where: { id: item.id },
        data: { matterCode: item.matterCode },
      }))
  )
  return codedItems
}

// GET /api/weekly-items?projectId=&startDate=&endDate=
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get("projectId")
  const startDate = searchParams.get("startDate")
  const endDate = searchParams.get("endDate")

  const where: Record<string, unknown> = {}
  if (projectId) where.projectId = projectId
  if (startDate || endDate) {
    const dueDateRange: Record<string, string> = {}
    if (startDate) dueDateRange.gte = startDate
    if (endDate) dueDateRange.lte = endDate
    where.OR = [
      { dueDate: "" },
      { dueDate: dueDateRange },
    ]
  }

  const items = await prisma.weeklyItem.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { dueDate: "asc" }, { createdAt: "asc" }],
    include: {
      project: {
        select: { id: true, name: true, code: true, status: true },
      },
      ganttTask: {
        select: { id: true, taskName: true },
      },
      riskItems: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: LINKED_RISK_SELECT,
      },
    },
  })

  const normalizedItems = await normalizeWeeklyMatterCodes(items)

  return ok(normalizedItems.map((item) => serializeItem(item as unknown as Record<string, unknown>)))
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const body = await req.json()
  if (!body.projectId) return err("项目 ID 不能为空")
  if (!body.title) return err("事项名称不能为空")
  if (!body.owner) return err("负责人不能为空")

  const project = await prisma.project.findUnique({ where: { id: body.projectId } })
  if (!project) return err("项目不存在")
  if (project.status === "COMPLETED" || project.status === "VOIDED") {
    return err("项目已作废或已完成，不允许添加事项")
  }

  const existingItems = await prisma.weeklyItem.findMany({
    where: { projectId: body.projectId },
    select: { id: true, matterCode: true, sortOrder: true, createdAt: true },
  })
  const matterCode = nextWeeklyMatterCode(existingItems)
  const lastItem = await prisma.weeklyItem.findFirst({
    where: { projectId: body.projectId },
    orderBy: [{ sortOrder: "desc" }, { createdAt: "desc" }],
    select: { sortOrder: true },
  })

  const requestedTaskId = typeof body.ganttTaskId === "string" ? body.ganttTaskId.trim() : ""
  const linkedTask = requestedTaskId
    ? await prisma.projectGanttTask.findFirst({
        where: { id: requestedTaskId, projectId: body.projectId },
        select: { id: true, taskName: true },
      })
    : null
  if (requestedTaskId && !linkedTask) return err("关联任务不存在或不属于当前项目")

  const item = await prisma.weeklyItem.create({
    data: {
      projectId: body.projectId,
      matterCode,
      sortOrder: (lastItem?.sortOrder ?? 0) + 1,
      title: body.title,
      ganttTaskId: linkedTask?.id ?? null,
      taskName: linkedTask?.taskName ?? "",
      description: body.description || "",
      dueDate: typeof body.dueDate === "string" ? body.dueDate : "",
      status: body.status || ItemStatus.PENDING,
      owner: body.owner,
      priority: body.priority || "NORMAL",
      ...buildExtraData(body),
    },
    include: {
      project: { select: { id: true, name: true, code: true, status: true } },
      ganttTask: { select: { id: true, taskName: true } },
      riskItems: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: LINKED_RISK_SELECT },
    },
  })

  await prisma.operationHistory.create({
    data: {
      projectId: body.projectId,
      entityType: "WEEKLY_ITEM",
      entityId: item.id,
      actionType: "CREATE",
      operator: user.displayName,
      detail: `新增项目事项「${item.title}」`,
    },
  })

  return ok(serializeItem(item as unknown as Record<string, unknown>), 201)
}
