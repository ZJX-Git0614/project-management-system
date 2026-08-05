import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized } from "@/lib/api-utils"
import { isValidItemProgress, itemProgressFields } from "@/lib/item-progress"
import {
  findProjectTasks,
  relationIdsFromBody,
  replaceWeeklyItemTaskLinks,
  serializeWeeklyItem,
  WEEKLY_ITEM_RELATION_INCLUDE,
} from "@/lib/project-associations"
import { nextWeeklyMatterCode, renumberWeeklyMatterCodesByProject } from "@/lib/weekly-matter-codes"

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
    include: WEEKLY_ITEM_RELATION_INCLUDE,
  })

  const normalizedItems = await normalizeWeeklyMatterCodes(items)

  return ok(normalizedItems.map(serializeWeeklyItem))
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const body = await req.json()
  if (!body.projectId) return err("项目 ID 不能为空")
  if (!body.title) return err("事项名称不能为空")
  if (!body.owner) return err("负责人不能为空")
  const progress = body.progress ?? 0
  if (!isValidItemProgress(progress)) return err("事项进度应为 0-100 的整数")
  const progressData = itemProgressFields(
    progress,
    typeof body.actualEndDate === "string" ? body.actualEndDate : "",
  )

  const project = await prisma.project.findUnique({ where: { id: body.projectId } })
  if (!project) return err("项目不存在")
  if (project.status === "COMPLETED" || project.status === "VOIDED") {
    return err("项目已作废或已完成，不允许添加事项")
  }

  const taskIds = relationIdsFromBody(body, "ganttTaskIds", "ganttTaskId") ?? []
  try {
    const item = await prisma.$transaction(async (tx) => {
      const tasks = await findProjectTasks(tx, body.projectId, taskIds)
      const existingItems = await tx.weeklyItem.findMany({
        where: { projectId: body.projectId },
        select: { id: true, matterCode: true, sortOrder: true, createdAt: true },
      })
      const lastItem = await tx.weeklyItem.findFirst({
        where: { projectId: body.projectId },
        orderBy: [{ sortOrder: "desc" }, { createdAt: "desc" }],
        select: { sortOrder: true },
      })
      const created = await tx.weeklyItem.create({
        data: {
          projectId: body.projectId,
          matterCode: nextWeeklyMatterCode(existingItems),
          sortOrder: (lastItem?.sortOrder ?? 0) + 1,
          title: body.title,
          description: body.description || "",
          dueDate: typeof body.dueDate === "string" ? body.dueDate : "",
          owner: body.owner,
          priority: body.priority || "NORMAL",
          ...buildExtraData(body),
          ...progressData,
        },
      })
      await replaceWeeklyItemTaskLinks(tx, created.id, tasks)
      await tx.operationHistory.create({
        data: {
          projectId: body.projectId,
          entityType: "WEEKLY_ITEM",
          entityId: created.id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `新增项目事项「${created.title}」`,
        },
      })
      return tx.weeklyItem.findUniqueOrThrow({
        where: { id: created.id },
        include: WEEKLY_ITEM_RELATION_INCLUDE,
      })
    })
    return ok(serializeWeeklyItem(item), 201)
  } catch (error) {
    return err(error instanceof Error ? error.message : "新增项目事项失败")
  }
}
