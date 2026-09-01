import jwt from "jsonwebtoken"
import bcrypt from "bcryptjs"
import { NextRequest } from "next/server"

const DEV_JWT_SECRET = "pms-dev-jwt-secret-change-in-production"
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须配置 JWT_SECRET 环境变量（随机长字符串），禁止使用默认密钥")
  }
  console.warn("[auth] 未配置 JWT_SECRET，正在使用开发默认密钥，切勿用于生产环境")
  return DEV_JWT_SECRET
})()
const JWT_EXPIRES_IN = "24h"
// 允许刷新的 token 最早签发时间：密码修改后旧 token 不得续签。
const REFRESH_GRACE_MS = 7 * 24 * 60 * 60 * 1000

export type TokenErrorCode = "TOKEN_EXPIRED" | "TOKEN_INVALID" | "TOKEN_MISSING"

export interface JwtPayload {
  userId: string
  username: string
  displayName: string
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10)
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash)
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload
  } catch {
    return null
  }
}

export function verifyTokenWithReason(token: string): { payload: JwtPayload; error: null } | { payload: null; error: TokenErrorCode } {
  if (!token) return { payload: null, error: "TOKEN_MISSING" }
  try {
    return { payload: jwt.verify(token, JWT_SECRET) as JwtPayload, error: null }
  } catch (e) {
    if (e instanceof jwt.TokenExpiredError) {
      return { payload: null, error: "TOKEN_EXPIRED" }
    }
    return { payload: null, error: "TOKEN_INVALID" }
  }
}

export function verifyTokenForRefresh(token: string): JwtPayload | null {
  const result = verifyTokenWithReason(token)
  if (result.payload) return result.payload
  if (result.error !== "TOKEN_EXPIRED") return null

  try {
    const payload = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true }) as JwtPayload & { iat?: number }
    // 过期 token 只在签发后 7 天内允许续签，超出后必须重新登录，
    // 限制泄露 token 的可续签窗口。
    if (typeof payload.iat === "number" && payload.iat * 1000 < Date.now() - REFRESH_GRACE_MS) {
      return null
    }
    return payload
  } catch {
    return null
  }
}

export function getTokenFromRequest(req: NextRequest): string | null {
  const header = req.headers.get("authorization")
  if (!header?.startsWith("Bearer ")) return null
  return header.slice(7)
}

export function getUserFromRequest(req: NextRequest): JwtPayload | null {
  const token = getTokenFromRequest(req)
  if (!token) return null
  return verifyToken(token)
}

export function getAuthErrorFromRequest(req: NextRequest): TokenErrorCode | null {
  const token = getTokenFromRequest(req)
  if (!token) return "TOKEN_MISSING"
  const result = verifyTokenWithReason(token)
  return result.error
}

export function requireAuth(req: NextRequest): JwtPayload {
  const user = getUserFromRequest(req)
  if (!user) {
    throw new Error("UNAUTHORIZED")
  }
  return user
}
