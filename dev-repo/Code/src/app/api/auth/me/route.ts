import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest, hashPassword, signToken, verifyPassword } from "@/lib/auth"
import { ok, err, unauthorized } from "@/lib/api-utils"

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const dbUser = await prisma.userAccount.findUnique({
    where: { id: user.userId },
  })
  if (!dbUser) return unauthorized()

  return ok({
    id: dbUser.id,
    username: dbUser.username,
    displayName: dbUser.displayName,
    assignedRoleNames: JSON.parse(dbUser.assignedRoleNames),
    passwordResetRequired: dbUser.passwordResetRequired,
  })
}

export async function PUT(req: NextRequest) {
  const authUser = getUserFromRequest(req)
  if (!authUser) return unauthorized()

  const body = await req.json()

  // 修改密码（首次登录强制改密不需要旧密码验证）
  if (body.newPassword) {
    if (typeof body.newPassword !== "string" || body.newPassword.length < 6) {
      return err("密码至少 6 位")
    }
    const dbUser = await prisma.userAccount.findUnique({
      where: { id: authUser.userId },
    })
    if (!dbUser) return err("用户不存在")

    // 如果不是强制改密场景，需要验证旧密码
    if (!dbUser.passwordResetRequired) {
      if (!body.oldPassword) return err("需要提供旧密码")
      if (!verifyPassword(body.oldPassword, dbUser.passwordHash)) {
        return err("旧密码不正确")
      }
    }

    const updated = await prisma.userAccount.update({
      where: { id: authUser.userId },
      data: {
        passwordHash: hashPassword(body.newPassword),
        passwordResetRequired: false,
        passwordUpdatedAt: new Date(),
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        assignedRoleNames: true,
        passwordResetRequired: true,
      },
    })
    const token = signToken({
      userId: updated.id,
      username: updated.username,
      displayName: updated.displayName,
    })
    return ok({
      message: "密码修改成功",
      token,
      user: {
        id: updated.id,
        username: updated.username,
        displayName: updated.displayName,
        assignedRoleNames: JSON.parse(updated.assignedRoleNames || "[]"),
        passwordResetRequired: updated.passwordResetRequired,
      },
    })
  }

  // 修改显示名
  if (body.displayName) {
    await prisma.userAccount.update({
      where: { id: authUser.userId },
      data: { displayName: body.displayName },
    })
    return ok({ message: "更新成功" })
  }

  return err("无有效操作")
}
