import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest, hashPassword } from "@/lib/auth"
import { ok, err, unauthorized, notFound } from "@/lib/api-utils"

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

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
