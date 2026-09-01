import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import { ok, err, notFound, unauthorizedFromRequest, forbidden } from "@/lib/api-utils"
import {
  findProjectMatters,
  relationIdsFromBody,
  replaceRiskMatterLinks,
  RISK_RELATION_INCLUDE,
  serializeRisk,
} from "@/lib/project-associations"
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
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "risk-register:edit")) return forbidden();

  const existing = await prisma.riskRegisterItem.findFirst({ where: { id: riskId, projectId: id } })
  if (!existing) return notFound("风险条目")

  const body = await req.json()
  const updateData: Record<string, unknown> = {}
  for (const k of PUTTABLE_FIELDS) {
    if (body[k] !== undefined) updateData[k] = body[k]
  }

  const weeklyItemIds = relationIdsFromBody(body, "weeklyItemIds", "weeklyItemId")
  try {
    const item = await prisma.$transaction(async (tx) => {
      const matters = weeklyItemIds === undefined
        ? undefined
        : await findProjectMatters(tx, existing.projectId, weeklyItemIds)
      await tx.riskRegisterItem.update({ where: { id: riskId }, data: updateData })
      if (matters) await replaceRiskMatterLinks(tx, riskId, matters)
      return tx.riskRegisterItem.findUniqueOrThrow({
        where: { id: riskId },
        include: RISK_RELATION_INCLUDE,
      })
    })
    return ok(serializeRisk(item))
  } catch (error) {
    return err(error instanceof Error ? error.message : "更新风险失败")
  }
}

// DELETE /api/projects/[id]/risk-register/[riskId]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; riskId: string }> }
) {
  const { id, riskId } = await params
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "risk-register:delete")) return forbidden();

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
