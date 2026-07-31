import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized, notFound } from "@/lib/api-utils"
import { isValidItemProgress, itemProgressFields, itemStatusFromProgress } from "@/lib/item-progress"
import { renumberWeeklyMatterCodes } from "@/lib/weekly-matter-codes"

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
  out.status = itemStatusFromProgress(Number(item.progress) || 0)
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

const PUTTABLE_FIELDS: readonly string[] = [
  "title", "description", "dueDate", "owner", "priority",
  "plannedStartDate", "actualStartDate", "plannedEndDate", "actualEndDate",
  "progress", "health", "issueAndAction", "dependency", "remark",
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
  if (!existing) return notFound("项目事项")

  const project = await prisma.project.findUnique({ where: { id: existing.projectId } })
  if (project && (project.status === "COMPLETED" || project.status === "VOIDED")) {
    return err("项目已作废或已完成，不允许修改事项")
  }

  const body = await req.json()
  const progress = body.progress === undefined ? existing.progress : body.progress
  if (!isValidItemProgress(progress)) return err("事项进度应为 0-100 的整数")
  const progressData = itemProgressFields(
    progress,
    body.actualEndDate === undefined
      ? existing.actualEndDate
      : typeof body.actualEndDate === "string" ? body.actualEndDate : "",
    undefined,
    existing.progress,
  )
  const updateData: Record<string, unknown> = {}
  for (const k of PUTTABLE_FIELDS) {
    if (body[k] !== undefined) updateData[k] = body[k]
  }
  Object.assign(updateData, progressData)

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
  }

  const item = await prisma.weeklyItem.update({
    where: { id },
    data: updateData,
    include: {
      project: { select: { id: true, name: true, code: true, status: true } },
      ganttTask: { select: { id: true, taskName: true } },
      riskItems: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: LINKED_RISK_SELECT },
    },
  })

  await prisma.operationHistory.create({
    data: {
      projectId: item.projectId,
      entityType: "WEEKLY_ITEM",
      entityId: item.id,
      actionType: progressData.status !== existing.status ? "STATUS_CHANGED" : "UPDATE",
      operator: user.displayName,
      detail: progressData.status !== existing.status
        ? `项目事项「${item.title}」状态随进度变更为 ${progressData.status}`
        : `更新项目事项「${item.title}」`,
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
  if (!existing) return notFound("项目事项")

  const project = await prisma.project.findUnique({ where: { id: existing.projectId } })
  if (project && (project.status === "COMPLETED" || project.status === "VOIDED")) {
    return err("项目已作废或已完成，不允许删除事项")
  }

  await prisma.$transaction(async (tx) => {
    await tx.weeklyItem.delete({ where: { id } })
    const remainingItems = await tx.weeklyItem.findMany({
      where: { projectId: existing.projectId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, matterCode: true, sortOrder: true, createdAt: true },
    })
    const renumberedItems = renumberWeeklyMatterCodes(
      remainingItems.map((item, index) => ({ ...item, sortOrder: index + 1 })),
    )
    await Promise.all(renumberedItems.map((item) => tx.weeklyItem.update({
      where: { id: item.id },
      data: { sortOrder: item.sortOrder, matterCode: item.matterCode },
    })))

    await tx.operationHistory.create({
      data: {
        projectId: existing.projectId,
        entityType: "WEEKLY_ITEM",
        entityId: id,
        actionType: "DELETE",
        operator: user.displayName,
        detail: `删除项目事项「${existing.title}」`,
      },
    })
  })

  return ok({ message: "已删除" })
}
