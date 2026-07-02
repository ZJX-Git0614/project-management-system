import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized } from "@/lib/api-utils"

// PUT /api/permission-tree
export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const body = await req.json()
  if (!body.data) return err("权限树数据不能为空")

  await prisma.permissionTree.upsert({
    where: { id: "default_tree" },
    update: { data: JSON.stringify(body.data) },
    create: { id: "default_tree", data: JSON.stringify(body.data) },
  })

  return ok({ message: "权限树保存成功" })
}

// GET /api/permission-tree
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const record = await prisma.permissionTree.findUnique({ where: { id: "default_tree" } })
  return ok(record ? { data: JSON.parse(record.data) } : { data: {} })
}
