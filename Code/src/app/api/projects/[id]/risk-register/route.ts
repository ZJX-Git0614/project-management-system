import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized, notFound } from "@/lib/api-utils"
import {
  findProjectMatters,
  relationIdsFromBody,
  replaceRiskMatterLinks,
  RISK_RELATION_INCLUDE,
  serializeRisk,
} from "@/lib/project-associations"
import { nextRiskCode, renumberRiskCodes } from "@/lib/risk-register-codes"

// GET /api/projects/[id]/risk-register
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return notFound("项目")

  const items = await prisma.riskRegisterItem.findMany({
    where: { projectId: id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: RISK_RELATION_INCLUDE,
  })

  const normalized = renumberRiskCodes(items)
  await Promise.all(normalized
    .filter((item, index) => item.riskCode !== items[index].riskCode)
    .map((item) => prisma.riskRegisterItem.update({ where: { id: item.id }, data: { riskCode: item.riskCode } })))

  return ok(normalized.map(serializeRisk))
}

// POST /api/projects/[id]/risk-register
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return notFound("项目")

  const body = await req.json()
  if (!body.riskName?.trim()) return err("风险名称不能为空")
  const weeklyItemIds = relationIdsFromBody(body, "weeklyItemIds", "weeklyItemId") ?? []
  try {
    const item = await prisma.$transaction(async (tx) => {
      const matters = await findProjectMatters(tx, id, weeklyItemIds)
      const lastItem = await tx.riskRegisterItem.findFirst({
        where: { projectId: id },
        orderBy: [{ sortOrder: "desc" }, { createdAt: "desc" }],
        select: { sortOrder: true },
      })
      const existingItems = await tx.riskRegisterItem.findMany({
        where: { projectId: id },
        select: { id: true, riskCode: true, sortOrder: true, createdAt: true },
      })
      const normalizedExistingItems = renumberRiskCodes(existingItems)
      await Promise.all(normalizedExistingItems
        .filter((risk, index) => risk.riskCode !== existingItems[index].riskCode)
        .map((risk) => tx.riskRegisterItem.update({
          where: { id: risk.id },
          data: { riskCode: risk.riskCode },
        })))

      const created = await tx.riskRegisterItem.create({
        data: {
          projectId: id,
          sortOrder: (lastItem?.sortOrder ?? 0) + 1,
          riskCode: nextRiskCode(normalizedExistingItems),
          riskName: body.riskName,
          ganttTaskId: null,
          weeklyItemId: null,
          linkedItemName: "",
          category: body.category || "",
          trigger: body.trigger || "",
          probability: body.probability || "中",
          impact: body.impact || "中",
          level: body.level || "中",
          response: body.response || "",
          owner: body.owner || "",
          status: body.status || "识别中",
          targetDate: body.targetDate || "",
        },
      })
      await replaceRiskMatterLinks(tx, created.id, matters)
      return tx.riskRegisterItem.findUniqueOrThrow({
        where: { id: created.id },
        include: RISK_RELATION_INCLUDE,
      })
    })
    return ok(serializeRisk(item), 201)
  } catch (error) {
    return err(error instanceof Error ? error.message : "新增风险失败")
  }
}
