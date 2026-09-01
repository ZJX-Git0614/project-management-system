import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { verifyPassword, signToken } from "@/lib/auth"
import { ok, err } from "@/lib/api-utils"
import { recordSystemEvent } from "@/lib/system-event-log"

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json()
    if (!username || !password) return err("用户名和密码不能为空")

    const user = await prisma.userAccount.findUnique({ where: { username } })
    if (!user) {
      await recordSystemEvent({ level: "SECURITY", category: "ADMIN", module: "auth", eventType: "LOGIN_FAILED", operatorName: String(username), message: "登录失败：账号不存在" })
      return err("用户名或密码错误", 401)
    }
    if (!user.enabled) {
      await recordSystemEvent({ level: "SECURITY", category: "ADMIN", module: "auth", eventType: "LOGIN_BLOCKED", operatorId: user.id, operatorName: user.displayName, message: "登录被拒绝：账号已禁用" })
      return err("账号已被禁用", 403)
    }

    if (!verifyPassword(password, user.passwordHash)) {
      await recordSystemEvent({ level: "SECURITY", category: "ADMIN", module: "auth", eventType: "LOGIN_FAILED", operatorId: user.id, operatorName: user.displayName, message: "登录失败：凭据校验未通过" })
      return err("用户名或密码错误", 401)
    }

    const token = signToken({
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
    })

    await recordSystemEvent({ level: "SECURITY", category: "ADMIN", module: "auth", eventType: "LOGIN_SUCCEEDED", operatorId: user.id, operatorName: user.displayName, message: "账号登录成功" })
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
    await recordSystemEvent({ level: "ERROR", category: "ERROR", module: "auth", eventType: "LOGIN_ERROR", message: e instanceof Error ? e.message : "登录处理失败" })
    return err("登录失败", 500)
  }
}
