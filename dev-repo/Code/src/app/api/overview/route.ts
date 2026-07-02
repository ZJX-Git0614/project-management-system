import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, unauthorized } from "@/lib/api-utils"
import { ProjectStatus } from "@/domain/enums"

// GET /api/overview
// 全局聚合：项目总数/状态分布、当前月/周事项统计
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const today = new Date()
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10)
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10)

  const day = today.getDay() || 7
  const monday = new Date(today)
  monday.setDate(today.getDate() - (day - 1))
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  const weekStart = monday.toISOString().slice(0, 10)
  const weekEnd = sunday.toISOString().slice(0, 10)

  const [
    totalProjects,
    inProgressProjects,
    completedProjects,
    voidedProjects,
    monthlyAll,
    monthlyDone,
    weeklyAll,
    weeklyDone,
    ganttTasks,
  ] = await Promise.all([
    prisma.project.count(),
    prisma.project.count({ where: { status: ProjectStatus.IN_PROGRESS } }),
    prisma.project.count({ where: { status: ProjectStatus.COMPLETED } }),
    prisma.project.count({ where: { status: ProjectStatus.VOIDED } }),
    prisma.monthlyItem.count({ where: { dueDate: { gte: monthStart, lte: monthEnd } } }),
    prisma.monthlyItem.count({ where: { dueDate: { gte: monthStart, lte: monthEnd }, status: "DONE" } }),
    prisma.weeklyItem.count({ where: { dueDate: { gte: weekStart, lte: weekEnd } } }),
    prisma.weeklyItem.count({ where: { dueDate: { gte: weekStart, lte: weekEnd }, status: "DONE" } }),
    prisma.projectGanttTask.findMany({
      orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
      include: {
        project: {
          select: { id: true, name: true, code: true, status: true },
        },
      },
    }),
  ])

  return ok({
    projects: {
      total: totalProjects,
      inProgress: inProgressProjects,
      completed: completedProjects,
      voided: voidedProjects,
    },
    monthlyItems: {
      total: monthlyAll,
      done: monthlyDone,
      monthStart,
      monthEnd,
    },
    weeklyItems: {
      total: weeklyAll,
      done: weeklyDone,
      weekStart,
      weekEnd,
    },
    ganttTasks: ganttTasks.map((task) => ({
      ...task,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    })),
  })
}
