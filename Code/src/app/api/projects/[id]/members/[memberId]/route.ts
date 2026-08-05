import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { ok, err, forbidden, notFound, unauthorizedFromRequest } from "@/lib/api-utils"
import { replaceGanttOwnerMember } from "@/lib/gantt-owner-service"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth"

const UNASSIGNED_REPLACEMENT = "__UNASSIGNED__"

const getMemberRemovalImpact = async (projectId: string, memberId: string) => {
  const member = await prisma.projectMember.findFirst({
    where: { id: memberId, projectId },
    select: { id: true, projectId: true, accountId: true, personName: true, roleName: true },
  })
  if (!member) return null

  const [replacementCandidates, tasks] = await Promise.all([
    prisma.projectMember.findMany({
      where: { projectId, id: { not: memberId } },
      select: { id: true, accountId: true, personName: true, roleName: true },
      orderBy: [{ personName: "asc" }, { roleName: "asc" }],
    }),
    prisma.projectGanttTask.findMany({
      where: {
        projectId,
        OR: [
          { ownerMemberId: memberId },
          { ownerLinks: { some: { projectMemberId: memberId } } },
        ],
      },
      select: { id: true, taskCode: true, taskName: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
  ])
  const taskIds = tasks.map((task) => task.id)
  const weeklyItems = await prisma.weeklyItem.findMany({
    where: {
      projectId,
      OR: [
        { owner: member.personName },
        ...(taskIds.length > 0 ? [
          { ganttTaskId: { in: taskIds } },
          { ganttTaskLinks: { some: { ganttTaskId: { in: taskIds } } } },
        ] : []),
      ],
    },
    select: { id: true, matterCode: true, title: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  })
  const weeklyItemIds = weeklyItems.map((item) => item.id)
  const risks = await prisma.riskRegisterItem.findMany({
    where: {
      projectId,
      OR: [
        { owner: member.personName },
        ...(taskIds.length > 0 ? [{ ganttTaskId: { in: taskIds } }] : []),
        ...(weeklyItemIds.length > 0 ? [
          { weeklyItemId: { in: weeklyItemIds } },
          { weeklyItemLinks: { some: { weeklyItemId: { in: weeklyItemIds } } } },
        ] : []),
      ],
    },
    select: { id: true, riskCode: true, riskName: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  })
  const defaultReplacement = replacementCandidates.find((candidate) => (
    member.accountId
      ? candidate.accountId === member.accountId
      : candidate.personName === member.personName
  ))

  return {
    member,
    replacementCandidates,
    defaultReplacementMemberId: defaultReplacement?.id ?? null,
    tasks,
    weeklyItems,
    risks,
    totalAssignments: tasks.length + weeklyItems.length + risks.length,
  }
}

// GET /api/projects/[id]/members/[memberId] - 删除前查看负责人影响范围
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> }
) {
  const { id, memberId } = await params
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "project-members:delete")) return forbidden()

  const project = await prisma.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return notFound("项目")
  const impact = await getMemberRemovalImpact(id, memberId)
  if (!impact) return notFound("项目成员")
  return ok(impact)
}

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

  const impact = await getMemberRemovalImpact(id, memberId)
  if (!impact) return notFound("项目成员")
  const confirmed = req.nextUrl.searchParams.get("confirmed") === "true"
  const replacementParameter = req.nextUrl.searchParams.get("replacementMemberId")
  if (impact.totalAssignments > 0 && (!confirmed || !replacementParameter)) {
    return err("该成员仍有负责事项，请先选择接替负责人或“未分配”", 409)
  }

  const replacementMemberId = replacementParameter && replacementParameter !== UNASSIGNED_REPLACEMENT
    ? replacementParameter
    : null
  if (replacementMemberId === memberId) return err("接替负责人不能是待删除成员")
  const replacementMember = replacementMemberId
    ? impact.replacementCandidates.find((candidate) => candidate.id === replacementMemberId)
    : null
  if (replacementMemberId && !replacementMember) return err("接替负责人必须是当前项目的其他成员")

  await prisma.$transaction(async (tx) => {
    await replaceGanttOwnerMember({
      tx,
      projectId: id,
      removedMemberId: memberId,
      removedPersonName: impact.member.personName,
      replacementMemberId,
      replacementPersonName: replacementMember?.personName ?? null,
    })
    await tx.projectMember.delete({ where: { id: memberId } })
    await tx.operationHistory.create({
      data: {
        projectId: id,
        entityType: "PROJECT_MEMBER",
        entityId: memberId,
        actionType: "DELETE",
        operator: user.displayName,
        detail: `移除项目成员 ${impact.member.personName}（${impact.member.roleName}）；${impact.totalAssignments > 0 ? `负责事项交接给 ${replacementMember?.personName ?? "未分配"}` : "无负责事项"}`,
      },
    })
  }, { timeout: 30_000, maxWait: 10_000 })

  return ok({
    message: "成员已移除",
    replacementMemberId,
    reassignedCount: impact.totalAssignments,
  })
}
