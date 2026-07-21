import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, unauthorized, notFound } from "@/lib/api-utils"

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

  if (body.ganttTaskId !== undefined) {
    const requestedTaskId = typeof body.ganttTaskId === "string" ? body.ganttTaskId.trim() : ""
    const linkedTask = requestedTaskId
      ? await prisma.projectGanttTask.findFirst({
          where: { id: requestedTaskId, projectId: existing.projectId },
          select: { id: true, taskName: true },
        })
      : null
    if (requestedTaskId && !linkedTask) return notFound("关联任务")
    updateData.ganttTaskId = linkedTask?.id ?? null
    updateData.linkedItemName = linkedTask?.taskName ?? ""
  } else if (body.linkedItemName !== undefined) {
    updateData.linkedItemName = body.linkedItemName
  }

  const item = await prisma.riskRegisterItem.update({
    where: { id: riskId },
    data: updateData,
    include: { ganttTask: { select: { id: true, taskName: true } } },
  })

  return ok({
    ...item,
    ganttTaskId: item.ganttTaskId ?? null,
    linkedItemName: item.ganttTask?.taskName ?? item.linkedItemName,
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

  await prisma.riskRegisterItem.delete({ where: { id: riskId } })

  return ok({ message: "已删除" })
}
