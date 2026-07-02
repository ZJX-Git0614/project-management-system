import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getTokenFromRequest, signToken, verifyTokenForRefresh } from "@/lib/auth"
import { ok, unauthorized } from "@/lib/api-utils"

// POST /api/auth/refresh
// 即使 token 过期也允许调用：用旧 token 换新 token。
// 用户不存在 / 被禁用时返回 401 + TOKEN_INVALID。
export async function POST(req: NextRequest) {
  const token = getTokenFromRequest(req)
  if (!token) return unauthorized("TOKEN_INVALID")

  const payload = verifyTokenForRefresh(token)
  if (!payload) return unauthorized("TOKEN_INVALID")

  const user = await prisma.userAccount.findUnique({ where: { id: payload.userId } })
  if (!user || !user.enabled) return unauthorized("TOKEN_INVALID")

  // 如果是 admin 在后台重置了密码 / 设了 passwordResetRequired，则告诉前端去改密
  if (user.passwordResetRequired) {
    return unauthorized("FORCED_RESET")
  }

  const newToken = signToken({
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
  })

  return ok({
    token: newToken,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      assignedRoleNames: JSON.parse(user.assignedRoleNames),
      passwordResetRequired: user.passwordResetRequired,
    },
  })
}
