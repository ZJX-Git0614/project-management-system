import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized, notFound } from "@/lib/api-utils"

const SERIALIZE_KEYS = [
  "id", "projectId", "matterCode", "sortOrder", "title", "ganttTaskId", "taskName", "description", "dueDate", "status", "owner", "priority",
  "plannedStartDate", "actualStartDate", "plannedEndDate", "actualEndDate",
  "progress", "health", "issueAndAction", "dependency", "risk", "riskStatus", "remark",
] as const

function serializeItem(item: Record<string, unknown>) {
  const out: Record<string, unknown> = { project: (item as { project?: unknown }).project }
  for (const k of SERIALIZE_KEYS) {
    out[k] = item[k]
  }
  const linkedTask = item.ganttTask as { taskName?: string } | null | undefined
  out.ganttTaskId = item.ganttTaskId ?? null
  out.taskName = linkedTask?.taskName ?? item.taskName ?? ""
  out.createdAt = (item.createdAt as Date).toISOString()
  out.updatedAt = (item.updatedAt as Date).toISOString()
  return out
}

const PUTTABLE_FIELDS: readonly string[] = [
  "title", "description", "dueDate", "status", "owner", "priority",
  "plannedStartDate", "actualStartDate", "plannedEndDate", "actualEndDate",
  "progress", "health", "issueAndAction", "dependency", "risk", "riskStatus", "remark",
]

// PUT /api/weekly-items/[id]
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const existing = await prisma.weeklyItem.findUnique({ where: { id } })
  if (!existing) return notFound("本周事项")

  const project = await prisma.project.findUnique({ where: { id: existing.projectId } })
  if (project && (project.status === "COMPLETED" || project.status === "VOIDED")) {
    return err("项目已作废或已完成，不允许修改事项")
  }

  const body = await req.json()
  const updateData: Record<string, unknown> = {}
  for (const k of PUTTABLE_FIELDS) {
    if (body[k] !== undefined) updateData[k] = body[k]
  }

  if (body.ganttTaskId !== undefined) {
    const requestedTaskId = typeof body.ganttTaskId === "string" ? body.ganttTaskId.trim() : ""
    const linkedTask = requestedTaskId
      ? await prisma.projectGanttTask.findFirst({
          where: { id: requestedTaskId, projectId: existing.projectId },
          select: { id: true, taskName: true },
        })
      : null
    if (requestedTaskId && !linkedTask) return err("关联任务不存在或不属于当前项目")
    updateData.ganttTaskId = linkedTask?.id ?? null
    updateData.taskName = linkedTask?.taskName ?? ""
  } else if (body.taskName !== undefined) {
    updateData.taskName = body.taskName
  }

  const item = await prisma.weeklyItem.update({
    where: { id },
    data: updateData,
    include: {
      project: { select: { id: true, name: true, code: true, status: true } },
      ganttTask: { select: { id: true, taskName: true } },
    },
  })

  await prisma.operationHistory.create({
    data: {
      projectId: item.projectId,
      entityType: "WEEKLY_ITEM",
      entityId: item.id,
      actionType: body.status && body.status !== existing.status ? "STATUS_CHANGED" : "UPDATE",
      operator: user.displayName,
      detail: body.status && body.status !== existing.status
        ? `本周事项「${item.title}」状态变更为 ${body.status}`
        : `更新本周事项「${item.title}」`,
    },
  })

  return ok(serializeItem(item as unknown as Record<string, unknown>))
}

// DELETE /api/weekly-items/[id]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const existing = await prisma.weeklyItem.findUnique({ where: { id } })
  if (!existing) return notFound("本周事项")

  const project = await prisma.project.findUnique({ where: { id: existing.projectId } })
  if (project && (project.status === "COMPLETED" || project.status === "VOIDED")) {
    return err("项目已作废或已完成，不允许删除事项")
  }

  await prisma.weeklyItem.delete({ where: { id } })

  await prisma.operationHistory.create({
    data: {
      projectId: existing.projectId,
      entityType: "WEEKLY_ITEM",
      entityId: id,
      actionType: "DELETE",
      operator: user.displayName,
      detail: `删除本周事项「${existing.title}」`,
    },
  })

  return ok({ message: "已删除" })
}
