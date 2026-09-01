import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { hashPassword } from "@/lib/auth"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth"
import { ok, err, unauthorizedFromRequest, forbidden, notFound } from "@/lib/api-utils"

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
  if (!body.password) return err("密码不能为空")

  await prisma.userAccount.update({
    where: { id },
    data: {
      passwordHash: hashPassword(body.password),
      passwordResetRequired: true,
      passwordUpdatedAt: new Date(),
    },
  })

  return ok({ message: "密码已重置" })
}
