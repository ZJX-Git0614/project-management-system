import { NextRequest } from "next/server"
import type { Prisma } from "@prisma/client"

import { err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import { replaceGanttOwnerMember } from "@/lib/gantt-owner-service"
import { prisma } from "@/lib/prisma"
import { normalizeRoleNames, parseRoleNames } from "@/lib/role-assignments"
import { syncRoleConfigPersonsFromAccounts } from "@/lib/role-persons"

const getRoleImpact = async (roleName: string) => {
  const accounts = await prisma.userAccount.findMany({
    select: { id: true, displayName: true, assignedRoleNames: true },
    orderBy: { createdAt: "asc" },
  })

  const assignedAccounts = accounts
    .filter((account) => parseRoleNames(account.assignedRoleNames).includes(roleName))
    .map((account) => ({
      id: account.id,
      displayName: account.displayName,
      assignedRoleNames: parseRoleNames(account.assignedRoleNames),
    }))
  const assignedAccountIds = assignedAccounts.map((account) => account.id)
  const memberships = await prisma.projectMember.findMany({
    where: {
      OR: [
        { roleName },
        ...(assignedAccountIds.length > 0 ? [{ accountId: { in: assignedAccountIds } }] : []),
      ],
    },
    select: {
      id: true,
      projectId: true,
      accountId: true,
      roleName: true,
      personName: true,
      project: { select: { name: true } },
    },
    orderBy: [{ projectId: "asc" }, { personName: "asc" }],
  })
  const projects = Array.from(
    memberships.reduce((result, membership) => {
      const current = result.get(membership.projectId) ?? {
        projectId: membership.projectId,
        projectName: membership.project.name,
        personNames: [] as string[],
        membershipIds: [] as string[],
      }
      if (!current.personNames.includes(membership.personName)) current.personNames.push(membership.personName)
      current.membershipIds.push(membership.id)
      result.set(membership.projectId, current)
      return result
    }, new Map<string, {
      projectId: string
      projectName: string
      personNames: string[]
      membershipIds: string[]
    }>()).values(),
  )

  return { accounts: assignedAccounts, projects, memberships }
}

const updatePermissionRoleName = async (
  tx: Prisma.TransactionClient,
  previousRoleName: string,
  nextRoleName?: string,
) => {
  const record = await tx.permissionTree.findUnique({ where: { id: "default_tree" } })
  if (!record) return

  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(record.data) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    parsed = value as Record<string, unknown>
  } catch {
    // 权限树异常时不用不完整数据覆盖原记录。
    return
  }

  const previousPermissions = Array.isArray(parsed[previousRoleName])
    ? parsed[previousRoleName].filter((item): item is string => typeof item === "string")
    : []
  delete parsed[previousRoleName]
  if (nextRoleName) {
    const existingPermissions = Array.isArray(parsed[nextRoleName])
      ? parsed[nextRoleName].filter((item): item is string => typeof item === "string")
      : []
    parsed[nextRoleName] = Array.from(new Set([...existingPermissions, ...previousPermissions]))
  }
  await tx.permissionTree.update({
    where: { id: record.id },
    data: { data: JSON.stringify(parsed) },
  })
}

// GET /api/role-config/[roleId] - 查看删除或改名的影响范围
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ roleId: string }> },
) {
  const { roleId } = await params
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);

  const config = await prisma.roleConfig.findUnique({ where: { id: roleId } })
  if (!config) return notFound("角色配置")
  const impact = await getRoleImpact(config.roleName)

  return ok({
    roleId: config.id,
    roleName: config.roleName,
    accountCount: impact.accounts.length,
    accounts: impact.accounts,
    projectCount: impact.projects.length,
    membershipCount: impact.memberships.length,
    projects: impact.projects.map(({ projectId, projectName, personNames }) => ({
      projectId,
      projectName,
      personNames,
    })),
  })
}

// PUT /api/role-config/[roleId]
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ roleId: string }> },
) {
  const { roleId } = await params
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "role-config:edit")) return forbidden()

  const config = await prisma.roleConfig.findUnique({ where: { id: roleId } })
  if (!config) return notFound("角色配置")

  const body = await req.json()
  if (body.systemPreset !== undefined) return err("系统预置标记不可修改", 403)
  const nextRoleName = body.roleName === undefined ? config.roleName : String(body.roleName).trim()
  if (!nextRoleName) return err("角色名称不能为空")
  const roleNameChanged = nextRoleName !== config.roleName
  if (config.systemPreset && roleNameChanged) return err("系统预置角色不可改名", 403)

  if (roleNameChanged) {
    const existing = await prisma.roleConfig.findUnique({ where: { roleName: nextRoleName } })
    if (existing) return err("角色名称已存在")
    if (body.confirmRoleChange !== true) {
      return err("角色名称变更会同步更新账号和项目成员，请确认影响后再保存", 409, "ROLE_CHANGE_CONFIRMATION_REQUIRED")
    }
  }

  const impact = roleNameChanged ? await getRoleImpact(config.roleName) : null
  const updated = await prisma.$transaction(async (tx) => {
    if (roleNameChanged && impact) {
      for (const account of impact.accounts) {
        const stored = await tx.userAccount.findUnique({
          where: { id: account.id },
          select: { assignedRoleNames: true },
        })
        if (!stored) continue
        const nextRoleNames = parseRoleNames(stored.assignedRoleNames)
          .map((roleName) => roleName === config.roleName ? nextRoleName : roleName)
        await tx.userAccount.update({
          where: { id: account.id },
          data: { assignedRoleNames: JSON.stringify(normalizeRoleNames(nextRoleNames)) },
        })
      }

      await tx.projectMember.updateMany({ where: { roleName: config.roleName }, data: { roleName: nextRoleName } })
      await updatePermissionRoleName(tx, config.roleName, nextRoleName)

      if (impact.projects.length > 0) {
        await tx.operationHistory.createMany({
          data: impact.projects.map((project) => ({
            projectId: project.projectId,
            entityType: "PROJECT_ROLE",
            entityId: roleId,
            actionType: "UPDATE",
            operator: user.displayName,
            detail: `项目角色「${config.roleName}」已改名为「${nextRoleName}」，相关成员信息已同步`,
          })),
        })
      }
      await tx.adminAuditLog.create({
        data: {
          actionType: "RENAME_PROJECT_ROLE",
          operator: user.displayName,
          detail: `项目角色「${config.roleName}」改名为「${nextRoleName}」`,
          snapshot: JSON.stringify({
            roleId,
            previousRoleName: config.roleName,
            nextRoleName,
            accounts: impact.accounts,
            projects: impact.projects,
          }),
        },
      })
    }

    return tx.roleConfig.update({
      where: { id: roleId },
      data: {
        roleName: nextRoleName,
        ...(body.allowMultiple !== undefined ? { allowMultiple: Boolean(body.allowMultiple) } : {}),
        ...(body.persons !== undefined ? { persons: JSON.stringify(normalizeRoleNames(body.persons)) } : {}),
      },
    })
  })

  await syncRoleConfigPersonsFromAccounts()
  return ok({
    ...updated,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
    impact: impact
      ? { accountCount: impact.accounts.length, projectCount: impact.projects.length }
      : { accountCount: 0, projectCount: 0 },
  })
}

// DELETE /api/role-config/[roleId]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ roleId: string }> },
) {
  const { roleId } = await params
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "role-config:edit")) return forbidden()

  const config = await prisma.roleConfig.findUnique({ where: { id: roleId } })
  if (!config) return notFound("角色配置")
  if (config.systemPreset) return err("系统预置角色不可删除", 403)
  if (req.nextUrl.searchParams.get("confirmed") !== "true") {
    return err("删除角色会同步解除账号和项目成员关联，请确认影响后再删除", 409, "ROLE_CHANGE_CONFIRMATION_REQUIRED")
  }

  const impact = await getRoleImpact(config.roleName)
  await prisma.$transaction(async (tx) => {
    const remainingRolesByAccount = new Map<string, string[]>()
    for (const account of impact.accounts) {
      const nextRoleNames = account.assignedRoleNames
        .filter((roleName) => roleName !== config.roleName)
      remainingRolesByAccount.set(account.id, nextRoleNames)
      await tx.userAccount.update({
        where: { id: account.id },
        data: { assignedRoleNames: JSON.stringify(nextRoleNames) },
      })
    }

    if (impact.memberships.length > 0) {
      const retainedMemberships = impact.memberships.filter((membership) => (
        membership.accountId && (remainingRolesByAccount.get(membership.accountId)?.length ?? 0) > 0
      ))
      for (const membership of retainedMemberships) {
        const nextRoleNames = remainingRolesByAccount.get(membership.accountId!) ?? []
        await tx.projectMember.updateMany({
          where: { id: membership.id },
          data: { roleName: nextRoleNames[0] },
        })
      }

      const removedMemberships = impact.memberships.filter((membership) => (
        !membership.accountId || (remainingRolesByAccount.get(membership.accountId)?.length ?? 0) === 0
      ))
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
      if (removedMemberships.length > 0) {
        await tx.projectMember.deleteMany({ where: { id: { in: removedMemberships.map((member) => member.id) } } })
      }
      await tx.operationHistory.createMany({
        data: impact.projects.map((project) => ({
          projectId: project.projectId,
          entityType: "PROJECT_ROLE",
          entityId: roleId,
          actionType: "DELETE",
          operator: user.displayName,
          detail: `删除项目角色「${config.roleName}」，${project.personNames.join("、") || "相关人员"}的项目成员角色已同步更新；无剩余角色的成员已移除`,
        })),
      })
    }
    await updatePermissionRoleName(tx, config.roleName)
    await tx.roleConfig.delete({ where: { id: roleId } })
    await tx.adminAuditLog.create({
      data: {
        actionType: "DELETE_PROJECT_ROLE",
        operator: user.displayName,
        detail: `删除项目角色「${config.roleName}」，已清理 ${impact.accounts.length} 个账号和 ${impact.memberships.length} 条项目成员关联`,
        snapshot: JSON.stringify({
          roleId,
          roleName: config.roleName,
          accounts: impact.accounts,
          projects: impact.projects,
        }),
      },
    })
  })

  return ok({
    message: "角色配置已删除，相关账号和项目成员已同步更新",
    accountCount: impact.accounts.length,
    projectCount: impact.projects.length,
    membershipCount: impact.memberships.length,
  })
}
