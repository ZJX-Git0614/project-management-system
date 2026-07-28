import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

import { getAuthErrorFromRequest } from "@/lib/auth"

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  code?: string
}

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ success: true, data }, { status })
}

export function err(error: string, status = 400, code?: string) {
  const body: ApiResponse = { success: false, error }
  if (code) body.code = code
  return NextResponse.json(body, { status })
}

export function unauthorized(code?: "TOKEN_EXPIRED" | "TOKEN_INVALID" | "FORCED_RESET") {
  const message = code === "TOKEN_EXPIRED"
    ? "登录已过期，请重新登录"
    : code === "FORCED_RESET"
      ? "账号需要重置密码"
      : "未登录"
  return NextResponse.json({ success: false, error: message, code: code ?? "UNAUTHORIZED" }, { status: 401 })
}

export function unauthorizedFromRequest(req: NextRequest) {
  const error = getAuthErrorFromRequest(req)
  if (error === "TOKEN_EXPIRED") return unauthorized("TOKEN_EXPIRED")
  return unauthorized()
}

export function forbidden() {
  return err("权限不足", 403)
}

export function notFound(entity = "资源") {
  return err(`${entity}不存在`, 404)
}

// 只读守卫：COMPLETED / VOIDED 状态的项目禁止任何写操作
const READ_ONLY_STATUSES = new Set(["COMPLETED", "VOIDED"])

export async function ensureMutableProject(projectId: string): Promise<NextResponse | null> {
  const { prisma } = await import("@/lib/prisma")
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) return notFound("项目")
  if (READ_ONLY_STATUSES.has(project.status)) {
    return err("项目已作废或已完成，不允许修改", 403)
  }
  return null
}

// 状态变更豁免：放行项目状态从只读到进行中的恢复操作
const ALLOWED_STATUS_TRANSITIONS = new Set(["IN_PROGRESS", "DRAFT"])

export function isStatusTransitionAllowed(currentStatus: string, newStatus?: string): boolean {
  if (!newStatus) return false
  return READ_ONLY_STATUSES.has(currentStatus) && ALLOWED_STATUS_TRANSITIONS.has(newStatus)
}
