import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import { ok, err, notFound, unauthorizedFromRequest, forbidden } from "@/lib/api-utils"
import { isValidItemProgress, itemProgressFields } from "@/lib/item-progress"
import {
  findProjectTasks,
  relationIdsFromBody,
  replaceWeeklyItemTaskLinks,
  serializeWeeklyItem,
  WEEKLY_ITEM_RELATION_INCLUDE,
} from "@/lib/project-associations"
import { renumberWeeklyMatterCodes } from "@/lib/weekly-matter-codes"

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
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "weekly-items:edit")) return forbidden();

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

  const taskIds = relationIdsFromBody(body, "ganttTaskIds", "ganttTaskId")
  try {
    const item = await prisma.$transaction(async (tx) => {
      const tasks = taskIds === undefined ? undefined : await findProjectTasks(tx, existing.projectId, taskIds)
      await tx.weeklyItem.update({ where: { id }, data: updateData })
      if (tasks) await replaceWeeklyItemTaskLinks(tx, id, tasks)
      const updated = await tx.weeklyItem.findUniqueOrThrow({
        where: { id },
        include: WEEKLY_ITEM_RELATION_INCLUDE,
      })
      await tx.operationHistory.create({
        data: {
          projectId: updated.projectId,
          entityType: "WEEKLY_ITEM",
          entityId: updated.id,
          actionType: progressData.status !== existing.status ? "STATUS_CHANGED" : "UPDATE",
          operator: user.displayName,
          detail: progressData.status !== existing.status
            ? `项目事项「${updated.title}」状态随进度变更为 ${progressData.status}`
            : `更新项目事项「${updated.title}」`,
        },
      })
      return updated
    })
    return ok(serializeWeeklyItem(item))
  } catch (error) {
    return err(error instanceof Error ? error.message : "更新项目事项失败")
  }
}

// DELETE /api/weekly-items/[id]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "weekly-items:delete")) return forbidden();

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
