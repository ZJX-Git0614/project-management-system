import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized, notFound } from "@/lib/api-utils"

// PUT /api/role-config/[roleId]
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ roleId: string }> }
) {
  const { roleId } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const config = await prisma.roleConfig.findUnique({ where: { id: roleId } })
  if (!config) return notFound("角色配置")

  const body = await req.json()
  const updateData: Record<string, unknown> = {}

  if (body.roleName !== undefined) {
    if (body.roleName !== config.roleName) {
      const existing = await prisma.roleConfig.findUnique({
        where: { roleName: body.roleName },
      })
      if (existing) return err("角色名称已存在")
    }
    updateData.roleName = body.roleName
  }
  if (body.allowMultiple !== undefined) updateData.allowMultiple = body.allowMultiple
  if (body.systemPreset !== undefined) updateData.systemPreset = body.systemPreset
  if (body.persons !== undefined) updateData.persons = body.persons

  const updated = await prisma.roleConfig.update({
    where: { id: roleId },
    data: updateData,
  })

  return ok({
    ...updated,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  })
}

// DELETE /api/role-config/[roleId]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ roleId: string }> }
) {
  const { roleId } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const config = await prisma.roleConfig.findUnique({ where: { id: roleId } })
  if (!config) return notFound("角色配置")

  // 检查角色人员库是否有人员
  const persons = (() => {
    try { return JSON.parse(config.persons || "[]"); } catch { return []; }
  })()
  if (persons.length > 0) {
    return err(`该角色「${config.roleName}」的人员库中还有 ${persons.length} 人（${persons.join("、")}），请先在后台账号管理中移除对应账号的角色分配后再删除。`)
  }

  await prisma.roleConfig.delete({ where: { id: roleId } })

  return ok({ message: "角色配置已删除" })
}
