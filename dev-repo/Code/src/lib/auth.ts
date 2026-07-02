import jwt from "jsonwebtoken"
import bcrypt from "bcryptjs"
import { NextRequest } from "next/server"

const JWT_SECRET = process.env.JWT_SECRET || "pmms-dev-jwt-secret-change-in-production"
const JWT_EXPIRES_IN = "24h"

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
    return jwt.verify(token, JWT_SECRET, { ignoreExpiration: true }) as JwtPayload
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
