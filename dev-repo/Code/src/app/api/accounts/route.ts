import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { hashPassword } from "@/lib/auth"
import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils"
import { syncRoleConfigPersonsFromAccounts } from "@/lib/role-persons"
import { normalizeRoleNames, parseRoleNames } from "@/lib/role-assignments"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth"

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "account-management:view")) return forbidden()

  const [accounts, roleConfigs] = await Promise.all([
    prisma.userAccount.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        username: true,
        displayName: true,
        enabled: true,
        assignedRoleNames: true,
        passwordResetRequired: true,
        passwordUpdatedAt: true,
        createdAt: true,
        projectMemberships: {
          select: {
            id: true,
            projectId: true,
            roleName: true,
            project: { select: { name: true } },
          },
          orderBy: [{ projectId: "asc" }, { roleName: "asc" }],
        },
      },
    }),
    prisma.roleConfig.findMany({ select: { roleName: true } }),
  ])
  const validRoleNames = new Set(roleConfigs.map((role) => role.roleName))

  return ok(
    accounts.map((a) => {
      const assignedRoleNames = parseRoleNames(a.assignedRoleNames).filter((roleName) => validRoleNames.has(roleName));
      return {
        ...a,
        assignedRoleNames,
        projectMemberships: a.projectMemberships.map((membership) => ({
          ...membership,
          roleName: assignedRoleNames.join("、"),
          roleNames: assignedRoleNames,
        })),
        passwordUpdatedAt: a.passwordUpdatedAt?.toISOString() ?? null,
        createdAt: a.createdAt.toISOString(),
      };
    })
  )
}

export async function POST(req: NextRequest) {
  const authUser = await getAuthenticatedUser(req)
  if (!authUser) return unauthorizedFromRequest(req)
  if (!await userHasPermission(authUser, "account-management:edit")) return forbidden()

  const body = await req.json()
  if (!body.username || !body.password) return err("用户名和密码不能为空")
  if (!body.displayName) return err("显示名不能为空")

  const existing = await prisma.userAccount.findUnique({
    where: { username: body.username },
  })
  if (existing) return err("用户名已存在")

  const assignedRoleNames = normalizeRoleNames(body.assignedRoleNames)
  const validRoleCount = await prisma.roleConfig.count({
    where: { roleName: { in: assignedRoleNames } },
  })
  if (validRoleCount !== assignedRoleNames.length) return err("所选角色已发生变化，请刷新页面后重新选择")

  const account = await prisma.userAccount.create({
    data: {
      username: body.username,
      displayName: body.displayName,
      enabled: body.enabled ?? true,
      assignedRoleNames: JSON.stringify(assignedRoleNames),
      passwordHash: hashPassword(body.password),
      passwordResetRequired: true,
      passwordUpdatedAt: new Date(),
    },
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

  return ok(
    { ...account, assignedRoleNames: parseRoleNames(account.assignedRoleNames), createdAt: account.createdAt.toISOString() },
    201
  )
}
