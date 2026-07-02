import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest, hashPassword } from "@/lib/auth"
import { ok, err, unauthorized } from "@/lib/api-utils"
import { syncRoleConfigPersonsFromAccounts } from "@/lib/role-persons"

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const accounts = await prisma.userAccount.findMany({
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
    },
  })

  return ok(
    accounts.map((a) => ({
      ...a,
      assignedRoleNames: JSON.parse(a.assignedRoleNames),
      passwordUpdatedAt: a.passwordUpdatedAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    }))
  )
}

export async function POST(req: NextRequest) {
  const authUser = getUserFromRequest(req)
  if (!authUser) return unauthorized()

  const body = await req.json()
  if (!body.username || !body.password) return err("用户名和密码不能为空")
  if (!body.displayName) return err("显示名不能为空")

  const existing = await prisma.userAccount.findUnique({
    where: { username: body.username },
  })
  if (existing) return err("用户名已存在")

  const account = await prisma.userAccount.create({
    data: {
      username: body.username,
      displayName: body.displayName,
      enabled: body.enabled ?? true,
      assignedRoleNames: JSON.stringify(body.assignedRoleNames || []),
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
    { ...account, assignedRoleNames: JSON.parse(account.assignedRoleNames), createdAt: account.createdAt.toISOString() },
    201
  )
}
