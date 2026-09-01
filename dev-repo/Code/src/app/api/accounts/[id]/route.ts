import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils"
import { replaceGanttOwnerMember } from "@/lib/gantt-owner-service"
import { syncRoleConfigPersonsFromAccounts } from "@/lib/role-persons"
import { projectMemberAccountWhere } from "@/lib/project-member-accounts"
import {
  diffRoleNames,
  normalizeRoleNames,
  parseRoleNames,
} from "@/lib/role-assignments"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth"

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "account-management:edit")) return forbidden()

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
  // 项目成员通过 accountId 关联账号；personName 仅作为展示快照保留。
  const oldDisplayName = existing.displayName
  const newDisplayName = body.displayName ?? oldDisplayName
  const oldRoleNames = parseRoleNames(existing.assignedRoleNames)
  if (body.assignedRoleNames !== undefined && !Array.isArray(body.assignedRoleNames)) {
    return err("项目角色格式不正确")
  }
  const newRoleNames = body.assignedRoleNames === undefined
    ? oldRoleNames
    : normalizeRoleNames(body.assignedRoleNames)
  const { addedRoleNames, removedRoleNames } = diffRoleNames(oldRoleNames, newRoleNames)
  const rolesChanged = addedRoleNames.length > 0 || removedRoleNames.length > 0

  if (rolesChanged) {
    const validRoleCount = await prisma.roleConfig.count({
      where: { roleName: { in: newRoleNames } },
    })
    if (validRoleCount !== newRoleNames.length) {
      return err("所选角色已发生变化，请刷新页面后重新选择")
    }
    if (body.confirmRoleChange !== true) {
      return err("账号角色发生变化，请确认影响后再保存", 409, "ROLE_CHANGE_CONFIRMATION_REQUIRED")
    }
    updateData.assignedRoleNames = JSON.stringify(newRoleNames)
  }

  const memberships = rolesChanged
    ? await prisma.projectMember.findMany({
        where: projectMemberAccountWhere(id, oldDisplayName),
        select: {
          id: true,
          projectId: true,
          accountId: true,
          roleName: true,
          personName: true,
          project: { select: { name: true } },
        },
      })
    : []
  const affectedProjects = Array.from(memberships.reduce((projects, membership) => {
    const existingProject = projects.get(membership.projectId) ?? {
      projectId: membership.projectId,
      projectName: membership.project.name,
      removedRoleNames,
      membershipIds: [] as string[],
    }
    existingProject.membershipIds.push(membership.id)
    projects.set(membership.projectId, existingProject)
    return projects
  }, new Map<string, {
    projectId: string
    projectName: string
    removedRoleNames: string[]
    membershipIds: string[]
  }>()).values())
  const removedMemberships = newRoleNames.length === 0 ? memberships : []
  const removedMembershipIds = removedMemberships.map((membership) => membership.id)

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
    if (rolesChanged && newRoleNames.length > 0 && memberships.length > 0) {
      await tx.projectMember.updateMany({
        where: { id: { in: memberships.map((membership) => membership.id) } },
        data: { accountId: id, personName: newDisplayName, roleName: newRoleNames[0] },
      })
      await tx.operationHistory.createMany({
        data: affectedProjects.map((project) => ({
          projectId: project.projectId,
          entityType: "PROJECT_MEMBER",
          entityId: id,
          actionType: "UPDATE",
          operator: user.displayName,
          detail: `账号角色变更：${newDisplayName}的项目角色已同步为${newRoleNames.join("、")}`,
        })),
      })
    } else if (removedMembershipIds.length > 0) {
      for (const membership of removedMemberships) {
        await replaceGanttOwnerMember({
          tx,
          projectId: membership.projectId,
          removedMemberId: membership.id,
          removedPersonName: membership.personName,
          replacementMemberId: null,
          replacementPersonName: null,
        })
      }
      await tx.projectMember.deleteMany({ where: { id: { in: removedMembershipIds } } })
      await tx.operationHistory.createMany({
        data: affectedProjects.map((project) => ({
          projectId: project.projectId,
          entityType: "PROJECT_MEMBER",
          entityId: id,
          actionType: "UPDATE",
          operator: user.displayName,
          detail: `账号角色变更：${oldDisplayName}已无有效角色，项目成员身份已同步移除`,
        })),
      })
    }
    if (newDisplayName !== oldDisplayName && !rolesChanged) {
      await tx.projectMember.updateMany({
        where: projectMemberAccountWhere(id, oldDisplayName),
        data: { accountId: id, personName: newDisplayName },
      })
    }
    if (rolesChanged) {
      await tx.adminAuditLog.create({
        data: {
          actionType: "UPDATE_ACCOUNT_ROLES",
          operator: user.displayName,
          detail: `调整账号「${newDisplayName}」的项目角色`,
          snapshot: JSON.stringify({
            accountId: id,
            previousRoleNames: oldRoleNames,
            nextRoleNames: newRoleNames,
            addedRoleNames,
            removedRoleNames,
            affectedProjects,
          }),
        },
      })
    }
    return account
  })

  await syncRoleConfigPersonsFromAccounts()

  return ok({
    ...updated,
    assignedRoleNames: parseRoleNames(updated.assignedRoleNames),
    createdAt: updated.createdAt.toISOString(),
    roleChange: {
      addedRoleNames,
      removedRoleNames,
      affectedProjects,
    },
  })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "account-management:edit")) return forbidden()

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
