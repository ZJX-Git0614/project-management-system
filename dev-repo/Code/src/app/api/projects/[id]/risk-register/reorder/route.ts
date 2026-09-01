import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import { ok, err, notFound, unauthorizedFromRequest, forbidden } from "@/lib/api-utils"
import { renumberRiskCodes } from "@/lib/risk-register-codes"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "risk-register:edit")) return forbidden();

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return notFound("项目")
  if (project.status === "COMPLETED" || project.status === "VOIDED") {
    return err("项目已作废或已完成，不允许调整风险排序")
  }

  const body = await req.json()
  const riskIds: string[] = Array.isArray(body.riskIds)
    ? body.riskIds.filter((riskId: unknown): riskId is string => typeof riskId === "string" && riskId.length > 0)
    : []
  if (riskIds.length === 0) return err("风险排序不能为空")

  const uniqueIds = [...new Set(riskIds)]
  if (uniqueIds.length !== riskIds.length) return err("风险排序存在重复项")

  const items = await prisma.riskRegisterItem.findMany({
    where: { projectId: id, id: { in: riskIds } },
    select: { id: true },
  })
  if (items.length !== riskIds.length) return err("风险排序数据不完整")

  await prisma.$transaction(async (tx) => {
    await Promise.all(
      riskIds.map((riskId: string, index: number) => (
        tx.riskRegisterItem.update({
          where: { id: riskId },
          data: { sortOrder: index + 1 },
        })
      ))
    )

    const orderedItems = await tx.riskRegisterItem.findMany({
      where: { projectId: id, id: { in: riskIds } },
      select: { id: true, riskCode: true, sortOrder: true, createdAt: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    })
    const renumbered = renumberRiskCodes(orderedItems)
    await Promise.all(renumbered.map((item) => tx.riskRegisterItem.update({
      where: { id: item.id },
      data: { riskCode: item.riskCode },
    })))

    await tx.operationHistory.create({
      data: {
        projectId: id,
        entityType: "PROJECT",
        entityId: id,
        actionType: "UPDATE",
        operator: user.displayName,
        detail: "调整风险登记册排序",
      },
    })
  })

  return ok({ message: "风险排序已保存" })
}
