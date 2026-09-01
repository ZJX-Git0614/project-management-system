import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils"
import { buildPersonsByRoleFromAccounts } from "@/lib/role-persons"

const parsePersons = (value: string) => {
  try {
    const parsed = JSON.parse(value || "[]")
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// GET /api/role-config
export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);

  const configs = await prisma.roleConfig.findMany({
    orderBy: { createdAt: "asc" },
  })

  const getPersonsForRole = await buildPersonsByRoleFromAccounts()

  return ok(
    configs.map((c) => ({
      ...c,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      persons: (() => {
        const syncedPersons = getPersonsForRole(c.roleName)
        return syncedPersons.length > 0 ? syncedPersons : parsePersons(c.persons)
      })(),
    }))
  )
}

// POST /api/role-config
export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "role-config:edit")) return forbidden()

  const body = await req.json()
  if (body.systemPreset !== undefined) return err("系统预置标记不可修改", 403)
  const roleName = typeof body.roleName === "string" ? body.roleName.trim() : ""
  if (!roleName) return err("角色名称不能为空")

  const existing = await prisma.roleConfig.findUnique({
    where: { roleName },
  })
  if (existing) return err("角色名称已存在")

  const config = await prisma.roleConfig.create({
    data: {
      roleName,
      allowMultiple: Boolean(body.allowMultiple),
      systemPreset: false,
      persons: JSON.stringify(body.persons || []),
    },
  })

  return ok(
    {
      ...config,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    },
    201
  )
}
