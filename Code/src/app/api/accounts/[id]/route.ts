import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized, notFound } from "@/lib/api-utils"
import { syncRoleConfigPersonsFromAccounts } from "@/lib/role-persons"

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const existing = await prisma.userAccount.findUnique({ where: { id } })
  if (!existing) return notFound("账号")

  const body = await req.json()
  const updateData: Record<string, unknown> = {}

  if (body.username !== undefined) {
    const dup = await prisma.userAccount.findFirst({
      where: { username: body.username, id: { not: id } },
    })
    if (dup) return err("用户名已被其他账号使用")
    updateData.username = body.username
  }
  if (body.displayName !== undefined) updateData.displayName = body.displayName
  if (body.enabled !== undefined) updateData.enabled = body.enabled
  if (body.assignedRoleNames !== undefined) updateData.assignedRoleNames = JSON.stringify(body.assignedRoleNames)

  // 如果修改了 displayName 或 assignedRoleNames，检查该人员是否在项目成员中
  const oldDisplayName = existing.displayName
  const newDisplayName = body.displayName ?? oldDisplayName
  const oldRoleNames = JSON.parse(existing.assignedRoleNames || "[]") as string[]
  const newRoleNames = body.assignedRoleNames ?? oldRoleNames
  const removedRoles = oldRoleNames.filter((r: string) => !newRoleNames.includes(r))

  // 如果显示名称变更，检查旧名称是否在项目成员中
  if (newDisplayName !== oldDisplayName) {
    const memberProjects = await prisma.projectMember.findMany({
      where: { personName: oldDisplayName },
      select: { projectId: true, roleName: true, project: { select: { name: true } } },
    })
    if (memberProjects.length > 0) {
      const projectList = memberProjects
        .map((m) => `「${m.project?.name ?? m.projectId}」（角色：${m.roleName}）`)
        .join("、")
      return err(
        `「${oldDisplayName}」正在以下项目中担任成员：${projectList}。如需修改名称，请先在对应的项目详情中移除该成员。`,
      )
    }
  }

  // 如果移除了某个角色，检查该人员在该角色下是否在项目成员中
  if (removedRoles.length > 0) {
    const memberInRemovedRoles = await prisma.projectMember.findMany({
      where: { personName: oldDisplayName, roleName: { in: removedRoles } },
      select: { projectId: true, roleName: true, project: { select: { name: true } } },
    })
    if (memberInRemovedRoles.length > 0) {
      const projectList = memberInRemovedRoles
        .map((m) => `「${m.project?.name ?? m.projectId}」（角色：${m.roleName}）`)
        .join("、")
      return err(
        `「${oldDisplayName}」正在以下项目中担任「${removedRoles.join("、")}」角色：${projectList}。如需移除角色，请先在对应的项目详情中移除该成员。`,
      )
    }
  }

  const updated = await prisma.userAccount.update({
    where: { id },
    data: updateData,
    select: {
      id: true,
      username: true,
      displayName: true,
      enabled: true,
      assignedRoleNames: true,
      passwordResetRequired: true,
      createdAt: true,
    },
  })

  await syncRoleConfigPersonsFromAccounts()

  return ok({
    ...updated,
    assignedRoleNames: JSON.parse(updated.assignedRoleNames),
    createdAt: updated.createdAt.toISOString(),
  })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const existing = await prisma.userAccount.findUnique({ where: { id } })
  if (!existing) return notFound("账号")

  // 检查该人员的 displayName 是否在项目成员中
  const memberProjects = await prisma.projectMember.findMany({
    where: { personName: existing.displayName },
    select: {
      projectId: true,
      roleName: true,
      project: { select: { name: true } },
    },
  })
  if (memberProjects.length > 0) {
    const projectList = memberProjects
      .map((m) => `「${m.project?.name ?? m.projectId}」（角色：${m.roleName}）`)
      .join("、")
    return err(
      `该人员「${existing.displayName}」正在以下项目中担任成员：${projectList}。如需删除，请先在对应的项目详情中移除该成员。`,
    )
  }

  await prisma.userAccount.delete({ where: { id } })
  await syncRoleConfigPersonsFromAccounts()
  return ok({ message: "账号已删除" })
}
