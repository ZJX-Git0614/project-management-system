import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized, notFound } from "@/lib/api-utils"

// POST /api/projects/[id]/members
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return notFound("项目")
  if (project.status === "COMPLETED" || project.status === "VOIDED") {
    return err("项目已作废或已完成，不允许添加成员")
  }

  const body = await req.json()
  if (!body.roleName || !body.personName) return err("角色和人员不能为空")

  const account = await prisma.userAccount.findFirst({
    where: {
      displayName: body.personName,
      enabled: true,
    },
    select: {
      assignedRoleNames: true,
    },
  })
  if (!account) return err("请选择后台账号管理中的启用账号")

  const assignedRoleNames = JSON.parse(account.assignedRoleNames || "[]") as string[]
  if (!assignedRoleNames.includes(body.roleName)) {
    return err("所选人员未分配该项目角色，请先在后台账号管理中调整角色")
  }

  const member = await prisma.projectMember.create({
    data: {
      projectId: id,
      roleName: body.roleName,
      personName: body.personName,
    },
  })

  await prisma.operationHistory.create({
    data: {
      projectId: id,
      entityType: "PROJECT_MEMBER",
      entityId: member.id,
      actionType: "CREATE",
      operator: user.displayName,
      detail: `添加项目成员 ${body.personName}（${body.roleName}）`,
    },
  })

  return ok(
    {
      ...member,
      createdAt: member.createdAt.toISOString(),
      updatedAt: member.updatedAt.toISOString(),
    },
    201
  )
}
