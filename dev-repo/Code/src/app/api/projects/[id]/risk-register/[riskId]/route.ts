import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, unauthorized, notFound } from "@/lib/api-utils"

const PUTTABLE_FIELDS = [
  "riskName", "linkedItemName", "category", "trigger",
  "probability", "impact", "level", "response", "owner", "status", "targetDate",
] as const

// PUT /api/projects/[id]/risk-register/[riskId]
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; riskId: string }> }
) {
  const { riskId } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const existing = await prisma.riskRegisterItem.findUnique({ where: { id: riskId } })
  if (!existing) return notFound("风险条目")

  const body = await req.json()
  const updateData: Record<string, unknown> = {}
  for (const k of PUTTABLE_FIELDS) {
    if (body[k] !== undefined) updateData[k] = body[k]
  }

  const item = await prisma.riskRegisterItem.update({
    where: { id: riskId },
    data: updateData,
  })

  return ok(item)
}

// DELETE /api/projects/[id]/risk-register/[riskId]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; riskId: string }> }
) {
  const { riskId } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const existing = await prisma.riskRegisterItem.findUnique({ where: { id: riskId } })
  if (!existing) return notFound("风险条目")

  await prisma.riskRegisterItem.delete({ where: { id: riskId } })

  return ok({ message: "已删除" })
}
