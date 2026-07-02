import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized, notFound } from "@/lib/api-utils"

// DELETE /api/projects/[id]/members/[memberId]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> }
) {
  const { id, memberId } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

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
