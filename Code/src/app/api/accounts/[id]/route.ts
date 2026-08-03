import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized, notFound } from "@/lib/api-utils"
import { syncRoleConfigPersonsFromAccounts } from "@/lib/role-persons"
import { projectMemberAccountWhere } from "@/lib/project-member-accounts"

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

  // 项目成员通过 accountId 关联账号；personName 仅作为展示快照保留。
  const oldDisplayName = existing.displayName
  const newDisplayName = body.displayName ?? oldDisplayName
  const oldRoleNames = JSON.parse(existing.assignedRoleNames || "[]") as string[]
  const newRoleNames = body.assignedRoleNames ?? oldRoleNames
  const removedRoles = oldRoleNames.filter((r: string) => !newRoleNames.includes(r))

  // 如果移除了某个角色，检查该人员在该角色下是否在项目成员中
  if (removedRoles.length > 0) {
    const memberInRemovedRoles = await prisma.projectMember.findMany({
      where: {
        ...projectMemberAccountWhere(id, oldDisplayName),
        roleName: { in: removedRoles },
      },
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

  const updated = await prisma.$transaction(async (tx) => {
    const account = await tx.userAccount.update({
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
    if (newDisplayName !== oldDisplayName) {
      await tx.projectMember.updateMany({
        where: projectMemberAccountWhere(id, oldDisplayName),
        data: { accountId: id, personName: newDisplayName },
      })
    }
    return account
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

  // 检查该账号是否仍关联项目成员；兼容尚未回填 accountId 的旧备份数据。
  const memberProjects = await prisma.projectMember.findMany({
    where: projectMemberAccountWhere(id, existing.displayName),
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
