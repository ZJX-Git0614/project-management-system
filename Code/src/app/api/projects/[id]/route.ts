import { rm } from "node:fs/promises"
import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { ok, err, forbidden, notFound, ensureMutableProject, isStatusTransitionAllowed, unauthorizedFromRequest } from "@/lib/api-utils"
import { getOrderedGanttTasks, serializeGanttTaskList } from "@/lib/gantt-task-service"
import { getProjectDocumentDirectory } from "@/lib/project-document-storage"
import { getValidProjectRoleNames, serializeProjectMember } from "@/lib/project-member-view"
import { getAuthenticatedUser, requireSystemAdmin, userHasPermission } from "@/lib/server-auth"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "project-info:view")) return forbidden()

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      projectMembers: {
        include: { account: { select: { displayName: true, assignedRoleNames: true } } },
        orderBy: [{ personName: "asc" }, { createdAt: "asc" }],
      },
      weeklyItems: { orderBy: { dueDate: "asc" } },
      todos: { orderBy: { createdAt: "desc" } },
      operationHistories: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  })

  if (!project) return notFound("项目")
  const [ganttTasks, validRoleNames] = await Promise.all([
    getOrderedGanttTasks(id),
    getValidProjectRoleNames(prisma),
  ])

  return ok({
    ...project,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    projectMembers: project.projectMembers.map((member) => serializeProjectMember(member, validRoleNames)),
    ganttTasks: serializeGanttTaskList(ganttTasks),
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
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)

  const existing = await prisma.project.findUnique({ where: { id } })
  if (!existing) return notFound("项目")

  const body = await req.json()
  const isOnlyStatusChange = Object.keys(body).length === 1 && body.status !== undefined
  const statusPermission = body.status === "ACTIVE"
    ? (existing.status === "DRAFT" ? "project-info:start" : "project-info:restore")
    : body.status === "COMPLETED"
      ? "project-info:complete"
      : body.status === "VOIDED"
        ? "project-info:void"
        : "project-info:edit"
  if (!await userHasPermission(user, isOnlyStatusChange ? statusPermission : "project-info:edit")) return forbidden()
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
  if (body.expectedEndDate !== undefined) updateData.expectedEndDate = body.expectedEndDate
  if (body.status !== undefined) updateData.status = body.status

  if (body.startDate !== undefined || body.expectedEndDate !== undefined) {
    const startDate = String(body.startDate !== undefined ? body.startDate : existing.startDate).trim()
    const expectedEndDate = String(body.expectedEndDate !== undefined ? body.expectedEndDate : existing.expectedEndDate).trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return err("开始时间格式应为 YYYY-MM-DD")
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedEndDate)) return err("预计结项时间格式应为 YYYY-MM-DD")
    if (expectedEndDate < startDate) return err("预计结项时间不能早于开始时间")
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
  const user = await requireSystemAdmin(req)
  if ("status" in user) return user

  const existing = await prisma.project.findUnique({ where: { id } })
  if (!existing) return notFound("项目")

  await prisma.project.delete({ where: { id } })
  await rm(getProjectDocumentDirectory(id), { recursive: true, force: true }).catch(() => undefined)
  return ok({ message: "项目已删除" })
}
