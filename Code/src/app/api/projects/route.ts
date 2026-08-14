import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { ok, err, forbidden, unauthorizedFromRequest } from "@/lib/api-utils"
import { resolveProjectMemberAccount } from "@/lib/project-member-accounts"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth"

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "project-list:view")) return forbidden()

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
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "project-list:create")) return forbidden()

  const body = await req.json()
  if (!body.name) return err("项目名称不能为空")
  const startDate = String(body.startDate ?? "").trim()
  const expectedEndDate = String(body.expectedEndDate ?? "").trim()
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return err("开始时间格式应为 YYYY-MM-DD，或留空使用相对 T0 排期")
  if (expectedEndDate && !/^\d{4}-\d{2}-\d{2}$/.test(expectedEndDate)) return err("预计结项时间格式应为 YYYY-MM-DD，或留空")
  if (startDate && expectedEndDate && expectedEndDate < startDate) return err("预计结项时间不能早于开始时间")

  const initialMember = body.initialMember
  if (initialMember?.roleName || initialMember?.personName) {
    if (!initialMember.roleName || !initialMember.personName) return err("项目组成员角色和人员不能为空")
  }

  const initialAccount = initialMember
    ? await resolveProjectMemberAccount({
        accountId: typeof initialMember.accountId === "string" ? initialMember.accountId : undefined,
        personName: initialMember.personName,
      })
    : null
  if (initialMember && !initialAccount) return err("请选择后台账号管理中的唯一启用账号")
  if (initialMember && initialAccount) {
    const assignedRoleNames = JSON.parse(initialAccount.assignedRoleNames || "[]") as string[]
    if (!assignedRoleNames.includes(initialMember.roleName)) {
      return err("所选人员未分配该项目角色，请先在后台账号管理中调整角色")
    }
  }

  const project = await prisma.project.create({
    data: {
      name: body.name,
      code: body.code || "",
      clientName: body.clientName || "",
      amountWan: body.amountWan || 0,
      deviceCount: body.deviceCount || 0,
      repairCycleDays: body.repairCycleDays || 0,
      startDate,
      expectedEndDate,
      status: body.status || "DRAFT",
      projectMembers: initialMember
        ? {
            create: {
              accountId: initialAccount?.id,
              roleName: initialMember.roleName,
              personName: initialAccount?.displayName ?? initialMember.personName,
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
