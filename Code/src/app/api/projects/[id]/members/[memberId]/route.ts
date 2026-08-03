import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { ok, err, forbidden, notFound, unauthorizedFromRequest } from "@/lib/api-utils"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth"

// DELETE /api/projects/[id]/members/[memberId]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> }
) {
  const { id, memberId } = await params
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "project-members:delete")) return forbidden()

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return notFound("项目")
  if (project.status === "COMPLETED" || project.status === "VOIDED") {
    return err("项目已作废或已完成，不允许修改成员")
  }

  const member = await prisma.projectMember.findUnique({ where: { id: memberId } })
  if (!member || member.projectId !== id) return notFound("项目成员")

  await prisma.projectMember.delete({ where: { id: memberId } })

  await prisma.operationHistory.create({
    data: {
      projectId: id,
      entityType: "PROJECT_MEMBER",
      entityId: memberId,
      actionType: "DELETE",
      operator: user.displayName,
      detail: `移除项目成员 ${member.personName}（${member.roleName}）`,
    },
  })

  return ok({ message: "成员已移除" })
}
