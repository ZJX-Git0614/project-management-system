import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized } from "@/lib/api-utils"
import { renumberWeeklyMatterCodes } from "@/lib/weekly-matter-codes"

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const body = await req.json()
  const itemIds: string[] = Array.isArray(body.itemIds)
    ? body.itemIds.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
    : []
  if (itemIds.length === 0) return err("事项排序不能为空")

  const uniqueIds = [...new Set(itemIds)]
  if (uniqueIds.length !== itemIds.length) return err("事项排序存在重复项")

  const items = await prisma.weeklyItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, projectId: true },
  })
  if (items.length !== itemIds.length) return err("事项排序数据不完整")

  const projects = await prisma.project.findMany({
    where: { id: { in: [...new Set(items.map((item) => item.projectId))] } },
    select: { id: true, status: true },
  })
  if (projects.some((project) => project.status === "COMPLETED" || project.status === "VOIDED")) {
    return err("项目已作废或已完成，不允许调整事项排序")
  }

  const projectIdByItemId = new Map(items.map((item) => [item.id, item.projectId]))
  const submittedIdsByProject = new Map<string, string[]>()
  itemIds.forEach((itemId) => {
    const projectId = projectIdByItemId.get(itemId)!
    const projectItemIds = submittedIdsByProject.get(projectId) ?? []
    projectItemIds.push(itemId)
    submittedIdsByProject.set(projectId, projectItemIds)
  })

  await prisma.$transaction(async (tx) => {
    const allProjectItems = await tx.weeklyItem.findMany({
      where: { projectId: { in: projects.map((project) => project.id) } },
      select: { id: true, projectId: true, matterCode: true, sortOrder: true, createdAt: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    })

    for (const project of projects) {
      const projectItems = allProjectItems.filter((item) => item.projectId === project.id)
      const submittedIds = submittedIdsByProject.get(project.id) ?? []
      const submittedIdSet = new Set(submittedIds)
      let submittedIndex = 0
      const reorderedItems = projectItems.map((item) => (
        submittedIdSet.has(item.id)
          ? projectItems.find((candidate) => candidate.id === submittedIds[submittedIndex++])!
          : item
      ))
      const renumbered = renumberWeeklyMatterCodes(
        reorderedItems.map((item, index) => ({ ...item, sortOrder: index + 1 })),
      )

      await Promise.all(
        renumbered.map((item) => (
          tx.weeklyItem.update({
            where: { id: item.id },
            data: { sortOrder: item.sortOrder, matterCode: item.matterCode },
          })
        )),
      )
    }

    await Promise.all(
      projects.map((project) => (
        tx.operationHistory.create({
          data: {
            projectId: project.id,
            entityType: "WEEKLY_ITEM",
            entityId: project.id,
            actionType: "UPDATE",
            operator: user.displayName,
            detail: "调整项目事项排序",
          },
        })
      ))
    )
  })

  return ok({ message: "事项排序已保存" })
}
