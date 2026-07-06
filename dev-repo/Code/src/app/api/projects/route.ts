import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized } from "@/lib/api-utils"

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const { searchParams } = new URL(req.url)
  const status = searchParams.get("status")

  const where: Record<string, unknown> = {}
  if (status) where.status = status

  const projects = await prisma.project.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: {
          projectMembers: true,
          weeklyItems: true,
        },
      },
    },
  })

  return ok(
    projects.map((p) => ({
      id: p.id,
      name: p.name,
      code: p.code,
      clientName: p.clientName,
      amountWan: p.amountWan,
      deviceCount: p.deviceCount,
      repairCycleDays: p.repairCycleDays,
      startDate: p.startDate,
      expectedEndDate: p.expectedEndDate,
      status: p.status,
      createdAt: p.createdAt.toISOString(),
      memberCount: p._count.projectMembers,
      weeklyItemCount: p._count.weeklyItems,
    }))
  )
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const body = await req.json()
  if (!body.name) return err("项目名称不能为空")

  let expectedEndDate = ""
  if (body.startDate && body.repairCycleDays) {
    const start = new Date(body.startDate)
    start.setDate(start.getDate() + Number(body.repairCycleDays))
    expectedEndDate = start.toISOString().split("T")[0]
  }

  const initialMember = body.initialMember
  if (initialMember?.roleName || initialMember?.personName) {
    if (!initialMember.roleName || !initialMember.personName) return err("项目组成员角色和人员不能为空")
  }

  const project = await prisma.project.create({
    data: {
      name: body.name,
      code: body.code || "",
      clientName: body.clientName || "",
      amountWan: body.amountWan || 0,
      deviceCount: body.deviceCount || 0,
      repairCycleDays: body.repairCycleDays || 0,
      startDate: body.startDate || "",
      expectedEndDate,
      status: body.status || "DRAFT",
      projectMembers: initialMember
        ? {
            create: {
              roleName: initialMember.roleName,
              personName: initialMember.personName,
            },
          }
        : undefined,
    },
  })

  return ok(
    {
      id: project.id,
      name: project.name,
      code: project.code,
      clientName: project.clientName,
      amountWan: project.amountWan,
      deviceCount: project.deviceCount,
      repairCycleDays: project.repairCycleDays,
      startDate: project.startDate,
      expectedEndDate: project.expectedEndDate,
      status: project.status,
      createdAt: project.createdAt.toISOString(),
    },
    201
  )
}
