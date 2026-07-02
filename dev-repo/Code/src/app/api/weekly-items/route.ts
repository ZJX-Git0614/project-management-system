import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized } from "@/lib/api-utils"
import { ItemStatus } from "@/domain/enums"

const SERIALIZE_KEYS = [
  "id", "projectId", "title", "description", "dueDate", "status", "owner", "priority",
  "plannedStartDate", "actualStartDate", "plannedEndDate", "actualEndDate",
  "progress", "health", "issueAndAction", "dependency", "risk", "riskStatus", "remark",
] as const

function serializeItem(item: Record<string, unknown>) {
  const out: Record<string, unknown> = { project: (item as { project?: unknown }).project }
  for (const k of SERIALIZE_KEYS) {
    out[k] = item[k]
  }
  out.createdAt = (item.createdAt as Date).toISOString()
  out.updatedAt = (item.updatedAt as Date).toISOString()
  return out
}

const EXTRA_FIELDS: readonly string[] = [
  "plannedStartDate", "actualStartDate", "plannedEndDate", "actualEndDate",
  "progress", "health", "issueAndAction", "dependency", "risk", "riskStatus", "remark",
]

function buildExtraData(body: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const k of EXTRA_FIELDS) {
    if (body[k] !== undefined) data[k] = body[k]
  }
  return data
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
    where.dueDate = {}
    if (startDate) (where.dueDate as Record<string, string>).gte = startDate
    if (endDate) (where.dueDate as Record<string, string>).lte = endDate
  }

  const items = await prisma.weeklyItem.findMany({
    where,
    orderBy: [{ dueDate: "asc" }, { priority: "desc" }, { createdAt: "asc" }],
    include: {
      project: {
        select: { id: true, name: true, code: true, status: true },
      },
    },
  })

  return ok(items.map((item) => serializeItem(item as unknown as Record<string, unknown>)))
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const body = await req.json()
  if (!body.projectId) return err("项目 ID 不能为空")
  if (!body.title) return err("事项标题不能为空")
  if (!body.dueDate) return err("截止日期不能为空")
  if (!body.owner) return err("负责人不能为空")

  const project = await prisma.project.findUnique({ where: { id: body.projectId } })
  if (!project) return err("项目不存在")
  if (project.status === "COMPLETED" || project.status === "VOIDED") {
    return err("项目已作废或已完成，不允许添加事项")
  }

  const item = await prisma.weeklyItem.create({
    data: {
      projectId: body.projectId,
      title: body.title,
      description: body.description || "",
      dueDate: body.dueDate,
      status: body.status || ItemStatus.PENDING,
      owner: body.owner,
      priority: body.priority || "NORMAL",
      ...buildExtraData(body),
    },
    include: {
      project: { select: { id: true, name: true, code: true, status: true } },
    },
  })

  await prisma.operationHistory.create({
    data: {
      projectId: body.projectId,
      entityType: "WEEKLY_ITEM",
      entityId: item.id,
      actionType: "CREATE",
      operator: user.displayName,
      detail: `新增本周事项「${item.title}」`,
    },
  })

  return ok(serializeItem(item as unknown as Record<string, unknown>), 201)
}
