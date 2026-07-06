import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, unauthorized } from "@/lib/api-utils"
import { ProjectStatus } from "@/domain/enums"

// GET /api/dashboard
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const projects = await prisma.project.findMany({
    select: { status: true },
  })
  const projectsByStatus: Record<string, number> = {}
  for (const p of projects) {
    projectsByStatus[p.status] = (projectsByStatus[p.status] || 0) + 1
  }

  const totalMembers = await prisma.projectMember.count()
  const totalWeeklyItems = await prisma.weeklyItem.count()

  const weeklyItemsByStatus = await prisma.weeklyItem.groupBy({
    by: ["status"],
    _count: true,
  })

  const todosByStatus = await prisma.todoItem.groupBy({
    by: ["status"],
    _count: true,
  })

  const recentHistory = await prisma.operationHistory.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
    include: {
      project: { select: { id: true, name: true } },
    },
  })

  return ok({
    totalProjects: projects.length,
    projectsByStatus: {
      [ProjectStatus.DRAFT]: projectsByStatus[ProjectStatus.DRAFT] ?? 0,
      [ProjectStatus.IN_PROGRESS]: projectsByStatus[ProjectStatus.IN_PROGRESS] ?? 0,
      [ProjectStatus.COMPLETED]: projectsByStatus[ProjectStatus.COMPLETED] ?? 0,
      [ProjectStatus.VOIDED]: projectsByStatus[ProjectStatus.VOIDED] ?? 0,
    },
    totalMembers,
    totalWeeklyItems,
    weeklyItemsByStatus: Object.fromEntries(
      weeklyItemsByStatus.map((r) => [r.status, r._count])
    ),
    todoCounts: Object.fromEntries(
      todosByStatus.map((t) => [t.status, t._count])
    ),
    recentHistory: recentHistory.map((h) => ({
      id: h.id,
      projectId: h.projectId,
      projectName: h.project.name,
      entityType: h.entityType,
      entityId: h.entityId,
      actionType: h.actionType,
      operator: h.operator,
      detail: h.detail,
      createdAt: h.createdAt.toISOString(),
    })),
  })
}
