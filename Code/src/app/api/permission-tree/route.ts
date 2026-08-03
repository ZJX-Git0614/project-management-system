import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { ok, err, forbidden, unauthorizedFromRequest } from "@/lib/api-utils"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth"
import { normalizePermissionTree, type PermissionTreeState } from "@/lib/permissions"

// PUT /api/permission-tree
export async function PUT(req: NextRequest) {
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "role-config:edit")) return forbidden()

  const body = await req.json()
  if (!body.data) return err("权限树数据不能为空")

  const normalized = normalizePermissionTree(body.data as Partial<PermissionTreeState>)
  await prisma.permissionTree.upsert({
    where: { id: "default_tree" },
    update: { data: JSON.stringify(normalized) },
    create: { id: "default_tree", data: JSON.stringify(normalized) },
  })

  return ok({ message: "权限树保存成功" })
}

// GET /api/permission-tree
export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)

  const record = await prisma.permissionTree.findUnique({ where: { id: "default_tree" } })
  if (!record) return ok({ data: {} })

  try {
    return ok({ data: normalizePermissionTree(JSON.parse(record.data) as Partial<PermissionTreeState>) })
  } catch {
    return ok({ data: normalizePermissionTree(undefined) })
  }
}
