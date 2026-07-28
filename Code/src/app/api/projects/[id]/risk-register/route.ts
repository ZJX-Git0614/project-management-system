import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized, notFound } from "@/lib/api-utils"
import { nextRiskCode, renumberRiskCodes } from "@/lib/risk-register-codes"

const serializeRisk = <T extends {
  weeklyItemId: string | null;
  weeklyItem?: { matterCode: string; title: string } | null;
}>(item: T) => {
  const { weeklyItem, ...risk } = item
  return {
    ...risk,
    weeklyItemId: item.weeklyItemId ?? null,
    linkedItemCode: weeklyItem?.matterCode ?? "",
    linkedItemName: weeklyItem?.title ?? "",
  }
}

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
    include: {
      weeklyItem: { select: { id: true, matterCode: true, title: true } },
    },
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
  const lastItem = await prisma.riskRegisterItem.findFirst({
    where: { projectId: id },
    orderBy: [{ sortOrder: "desc" }, { createdAt: "desc" }],
    select: { sortOrder: true },
  })
  const existingItems = await prisma.riskRegisterItem.findMany({
    where: { projectId: id },
    select: { id: true, riskCode: true, sortOrder: true, createdAt: true },
  })
  const normalizedExistingItems = renumberRiskCodes(existingItems)

  const requestedWeeklyItemId = typeof body.weeklyItemId === "string" ? body.weeklyItemId.trim() : ""
  const linkedItem = requestedWeeklyItemId
    ? await prisma.weeklyItem.findFirst({
        where: { id: requestedWeeklyItemId, projectId: id },
        select: { id: true, matterCode: true, title: true },
      })
    : null
  if (requestedWeeklyItemId && !linkedItem) return err("关联事项不存在或不属于当前项目")

  const item = await prisma.$transaction(async (tx) => {
    await Promise.all(normalizedExistingItems
      .filter((item, index) => item.riskCode !== existingItems[index].riskCode)
      .map((item) => tx.riskRegisterItem.update({
        where: { id: item.id },
        data: { riskCode: item.riskCode },
      })))

    return tx.riskRegisterItem.create({
      data: {
        projectId: id,
        sortOrder: (lastItem?.sortOrder ?? 0) + 1,
        riskCode: nextRiskCode(normalizedExistingItems),
        riskName: body.riskName,
        weeklyItemId: linkedItem?.id ?? null,
        ganttTaskId: null,
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
      include: { weeklyItem: { select: { id: true, matterCode: true, title: true } } },
    })
  })

  return ok(serializeRisk(item), 201)
}
