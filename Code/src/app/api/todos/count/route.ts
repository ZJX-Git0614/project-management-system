import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, unauthorized } from "@/lib/api-utils"

// GET /api/todos/count - 返回当前用户角色的 OPEN 待办数量
export async function GET(req: NextRequest) {
  const authUser = getUserFromRequest(req)
  if (!authUser) return unauthorized()

  // 从 DB 获取用户角色
  const dbUser = await prisma.userAccount.findUnique({
    where: { id: authUser.userId },
    select: { assignedRoleNames: true },
  })
  if (!dbUser) return unauthorized()

  const roleNames: string[] = JSON.parse(dbUser.assignedRoleNames || "[]")
  const isAdmin = roleNames.includes("管理员")

  const targetRoles: string[] = []
  if (roleNames.includes("项目经理")) targetRoles.push("PROJECT_MANAGER")
  if (roleNames.includes("项目成员")) targetRoles.push("MEMBER")
  const where = isAdmin
    ? { status: "OPEN" }
    : {
        status: "OPEN",
        OR: [
          { targetPersonName: authUser.displayName },
          ...(targetRoles.length > 0 ? [{ targetPersonName: null, targetRole: { in: targetRoles } }] : []),
        ],
      }

  const [todoCount, notificationCount] = await Promise.all([
    prisma.todoItem.count({ where }),
    isAdmin
      ? prisma.systemBackupRecord.count({ where: { status: { in: ["FAILED", "PARTIAL"] }, notificationReadAt: null } })
      : Promise.resolve(0),
  ])
  return ok({ count: todoCount + notificationCount, todoCount, notificationCount })
}
