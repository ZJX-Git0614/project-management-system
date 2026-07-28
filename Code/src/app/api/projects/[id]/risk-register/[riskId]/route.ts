import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized, notFound } from "@/lib/api-utils"
import { renumberRiskCodes } from "@/lib/risk-register-codes"

const PUTTABLE_FIELDS = [
  "riskName", "category", "trigger",
  "probability", "impact", "level", "response", "owner", "status", "targetDate",
] as const

// PUT /api/projects/[id]/risk-register/[riskId]
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; riskId: string }> }
) {
  const { id, riskId } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const existing = await prisma.riskRegisterItem.findFirst({ where: { id: riskId, projectId: id } })
  if (!existing) return notFound("风险条目")

  const body = await req.json()
  const updateData: Record<string, unknown> = {}
  for (const k of PUTTABLE_FIELDS) {
    if (body[k] !== undefined) updateData[k] = body[k]
  }

  if (body.weeklyItemId !== undefined) {
    const requestedWeeklyItemId = typeof body.weeklyItemId === "string" ? body.weeklyItemId.trim() : ""
    const linkedItem = requestedWeeklyItemId
      ? await prisma.weeklyItem.findFirst({
          where: { id: requestedWeeklyItemId, projectId: existing.projectId },
          select: { id: true, matterCode: true, title: true },
        })
      : null
    if (requestedWeeklyItemId && !linkedItem) return err("关联事项不存在或不属于当前项目")
    updateData.weeklyItemId = linkedItem?.id ?? null
    updateData.ganttTaskId = null
    updateData.linkedItemName = ""
  }

  const item = await prisma.riskRegisterItem.update({
    where: { id: riskId },
    data: updateData,
    include: { weeklyItem: { select: { id: true, matterCode: true, title: true } } },
  })

  const { weeklyItem, ...risk } = item
  return ok({
    ...risk,
    weeklyItemId: item.weeklyItemId ?? null,
    linkedItemCode: weeklyItem?.matterCode ?? "",
    linkedItemName: weeklyItem?.title ?? "",
  })
}

// DELETE /api/projects/[id]/risk-register/[riskId]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; riskId: string }> }
) {
  const { id, riskId } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const existing = await prisma.riskRegisterItem.findFirst({ where: { id: riskId, projectId: id } })
  if (!existing) return notFound("风险条目")

  await prisma.$transaction(async (tx) => {
    await tx.riskRegisterItem.delete({ where: { id: riskId } })
    const remainingItems = await tx.riskRegisterItem.findMany({
      where: { projectId: id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, riskCode: true, sortOrder: true, createdAt: true },
    })
    const renumberedItems = renumberRiskCodes(
      remainingItems.map((item, index) => ({ ...item, sortOrder: index + 1 })),
    )
    await Promise.all(renumberedItems.map((item) => tx.riskRegisterItem.update({
      where: { id: item.id },
      data: { sortOrder: item.sortOrder, riskCode: item.riskCode },
    })))
  })

  return ok({ message: "已删除" })
}
