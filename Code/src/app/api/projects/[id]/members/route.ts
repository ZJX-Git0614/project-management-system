import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { ok, err, forbidden, notFound, unauthorizedFromRequest } from "@/lib/api-utils"
import { resolveProjectMemberAccount } from "@/lib/project-member-accounts"
import { getValidProjectRoleNames, serializeProjectMember } from "@/lib/project-member-view"
import { parseRoleNames } from "@/lib/role-assignments"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth"

// GET /api/projects/[id]/members
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "project-members:view")) return forbidden()

  const project = await prisma.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return notFound("项目")

  const members = await prisma.projectMember.findMany({
    where: { projectId: id },
    include: { account: { select: { displayName: true, assignedRoleNames: true } } },
    orderBy: [{ personName: "asc" }, { createdAt: "asc" }],
  })
  const validRoleNames = await getValidProjectRoleNames(prisma)
  return ok(members.map((member) => serializeProjectMember(member, validRoleNames)))
}

// POST /api/projects/[id]/members
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "project-members:create")) return forbidden()

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return notFound("项目")
  if (project.status === "COMPLETED" || project.status === "VOIDED") {
    return err("项目已作废或已完成，不允许添加成员")
  }

  const body = await req.json()
  if (!body.accountId && !body.personName) return err("人员不能为空")

  const account = await resolveProjectMemberAccount({
    accountId: typeof body.accountId === "string" ? body.accountId : undefined,
    personName: typeof body.personName === "string" ? body.personName : undefined,
  })
  if (!account) return err("请选择后台账号管理中的唯一启用账号")

  const validRoleNames = await getValidProjectRoleNames(prisma)
  const assignedRoleNames = parseRoleNames(account.assignedRoleNames)
    .filter((roleName) => validRoleNames.has(roleName))
  if (assignedRoleNames.length === 0) return err("所选人员没有有效项目角色，请先在后台账号管理中分配角色")

  const existingMember = await prisma.projectMember.findFirst({
    where: { projectId: id, accountId: account.id },
    select: { id: true },
  })
  if (existingMember) return err("该账号已经是项目成员，不能重复添加", 409)

  const member = await prisma.projectMember.create({
    data: {
      projectId: id,
      accountId: account.id,
      roleName: assignedRoleNames[0],
      personName: account.displayName,
    },
  })

  await prisma.operationHistory.create({
    data: {
      projectId: id,
      entityType: "PROJECT_MEMBER",
      entityId: member.id,
      actionType: "CREATE",
      operator: user.displayName,
      detail: `添加项目成员 ${account.displayName}（${assignedRoleNames.join("、")}）`,
    },
  })

  return ok(
    {
      ...serializeProjectMember({ ...member, account }, validRoleNames),
    },
    201
  )
}
