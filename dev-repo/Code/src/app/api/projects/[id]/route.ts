import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, unauthorized, notFound, ensureMutableProject, isStatusTransitionAllowed } from "@/lib/api-utils"
import { getOrderedGanttTasks, serializeGanttTask } from "@/lib/gantt-task-service"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      projectMembers: true,
      weeklyItems: { orderBy: { dueDate: "asc" } },
      todos: { orderBy: { createdAt: "desc" } },
      operationHistories: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  })

  if (!project) return notFound("项目")
  const ganttTasks = await getOrderedGanttTasks(id)

  return ok({
    ...project,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    projectMembers: project.projectMembers.map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
    })),
    ganttTasks: ganttTasks.map(serializeGanttTask),
    weeklyItems: project.weeklyItems.map((w) => ({
      ...w,
      createdAt: w.createdAt.toISOString(),
    })),
    todos: project.todos.map((t) => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
    })),
    operationHistories: project.operationHistories.map((h) => ({
      ...h,
      createdAt: h.createdAt.toISOString(),
    })),
  })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const existing = await prisma.project.findUnique({ where: { id } })
  if (!existing) return notFound("项目")

  const body = await req.json()
  const isOnlyStatusChange = Object.keys(body).length === 1 && body.status !== undefined
  if (
    !isOnlyStatusChange ||
    !isStatusTransitionAllowed(existing.status, body.status)
  ) {
    const m = await ensureMutableProject(id)
    if (m) return m
  }

  const updateData: Record<string, unknown> = {}

  if (body.name !== undefined) updateData.name = body.name
  if (body.code !== undefined) updateData.code = body.code
  if (body.clientName !== undefined) updateData.clientName = body.clientName
  if (body.amountWan !== undefined) updateData.amountWan = body.amountWan
  if (body.deviceCount !== undefined) updateData.deviceCount = body.deviceCount
  if (body.repairCycleDays !== undefined)
    updateData.repairCycleDays = body.repairCycleDays
  if (body.startDate !== undefined) updateData.startDate = body.startDate
  if (body.status !== undefined) updateData.status = body.status

  const startDate =
    body.startDate !== undefined ? body.startDate : existing.startDate
  const repairCycleDays =
    body.repairCycleDays !== undefined
      ? body.repairCycleDays
      : existing.repairCycleDays
  if (startDate && repairCycleDays) {
    const start = new Date(startDate)
    start.setDate(start.getDate() + Number(repairCycleDays))
    updateData.expectedEndDate = start.toISOString().split("T")[0]
  }

  const project = await prisma.project.update({
    where: { id },
    data: updateData,
  })

  return ok({ ...project, createdAt: project.createdAt.toISOString() })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const existing = await prisma.project.findUnique({ where: { id } })
  if (!existing) return notFound("项目")

  await prisma.project.delete({ where: { id } })
  return ok({ message: "项目已删除" })
}
