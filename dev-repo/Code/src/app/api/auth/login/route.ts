import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { verifyPassword, signToken } from "@/lib/auth"
import { ok, err } from "@/lib/api-utils"

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json()
    if (!username || !password) return err("用户名和密码不能为空")

    const user = await prisma.userAccount.findUnique({ where: { username } })
    if (!user) return err("用户名或密码错误", 401)
    if (!user.enabled) return err("账号已被禁用", 403)

    if (!verifyPassword(password, user.passwordHash)) {
      return err("用户名或密码错误", 401)
    }

    const token = signToken({
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
    })

    return ok({
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        assignedRoleNames: JSON.parse(user.assignedRoleNames),
        passwordResetRequired: user.passwordResetRequired,
      },
    })
  } catch (e) {
    console.error("Login error:", e)
    return err("登录失败", 500)
  }
}
