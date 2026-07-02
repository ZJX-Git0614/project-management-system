import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized } from "@/lib/api-utils"
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
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

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
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const body = await req.json()
  if (!body.roleName)
    return err("角色名称不能为空")

  const existing = await prisma.roleConfig.findUnique({
    where: { roleName: body.roleName },
  })
  if (existing) return err("角色名称已存在")

  const config = await prisma.roleConfig.create({
    data: {
      roleName: body.roleName,
      allowMultiple: body.allowMultiple || false,
      systemPreset: body.systemPreset || false,
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
