import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { authorizeProjectAccess } from "@/lib/project-authorization";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

const serializeMember = (member: { id: string; personName: string; roleName: string }) => ({
  id: member.id,
  personName: member.personName,
  roleName: member.roleName,
});

const serializeAssignment = (assignment: {
  taskId: string;
  projectMemberId: string;
  plannedWorkHours: number;
  remark: string;
  createdAt: Date;
  updatedAt: Date;
  projectMember: { id: string; personName: string; roleName: string };
}) => ({
  taskId: assignment.taskId,
  projectMemberId: assignment.projectMemberId,
  plannedWorkHours: assignment.plannedWorkHours,
  remark: assignment.remark,
  createdAt: assignment.createdAt.toISOString(),
  updatedAt: assignment.updatedAt.toISOString(),
  projectMember: serializeMember(assignment.projectMember),
});

const getLeafTask = async (projectId: string, taskId: string) => {
  const task = await prisma.projectGanttTask.findFirst({
    where: { id: taskId, projectId },
    select: {
      id: true,
      taskCode: true,
      taskName: true,
      estimatedWorkHours: true,
      ownerMemberId: true,
      budgetItemId: true,
    },
  });
  if (!task) return { error: notFound("甘特任务") } as const;
  const childCount = await prisma.projectGanttTask.count({ where: { projectId, parentId: taskId } });
  if (childCount > 0) return { error: err("父级汇总任务的投入人员由末级任务决定") } as const;
  return { task } as const;
};

// GET /api/projects/[id]/gantt-tasks/[taskId]/labor-assignments
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:view")) return forbidden();
  const accessError = await authorizeProjectAccess(user, id);
  if (accessError) return accessError;

  const result = await getLeafTask(id, taskId);
  if ("error" in result) return result.error;
  const [assignments, members] = await Promise.all([
    prisma.projectGanttTaskLaborAssignment.findMany({
      where: { taskId },
      include: { projectMember: { select: { id: true, personName: true, roleName: true } } },
      orderBy: [{ projectMember: { personName: "asc" } }, { createdAt: "asc" }],
    }),
    prisma.projectMember.findMany({
      where: { projectId: id },
      select: { id: true, personName: true, roleName: true },
      orderBy: [{ personName: "asc" }, { createdAt: "asc" }],
    }),
  ]);
  return ok({
    task: result.task,
    members: members.map(serializeMember),
    assignments: assignments.map(serializeAssignment),
  });
}

// PUT /api/projects/[id]/gantt-tasks/[taskId]/labor-assignments
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:edit")) return forbidden();
  const accessError = await authorizeProjectAccess(user, id);
  if (accessError) return accessError;
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const result = await getLeafTask(id, taskId);
  if ("error" in result) return result.error;
  const body = await req.json() as { assignments?: unknown };
  if (!Array.isArray(body.assignments)) return err("WBS 人员分工数据格式不正确");
  const assignments = body.assignments.map((value) => {
    const item = value as Record<string, unknown>;
    return {
      projectMemberId: String(item.projectMemberId ?? "").trim(),
      plannedWorkHours: Number(item.plannedWorkHours ?? 0),
      remark: String(item.remark ?? "").trim().slice(0, 500),
    };
  });
  if (assignments.some((assignment) => (
    !assignment.projectMemberId
    || !Number.isFinite(assignment.plannedWorkHours)
    || assignment.plannedWorkHours < 0
  ))) return err("人员和计划工时必须为合法的非负数");
  if (new Set(assignments.map((assignment) => assignment.projectMemberId)).size !== assignments.length) {
    return err("同一 WBS 任务不能重复分配给同一人员");
  }
  const memberIds = assignments.map((assignment) => assignment.projectMemberId);
  const validMemberCount = memberIds.length === 0 ? 0 : await prisma.projectMember.count({
    where: { projectId: id, id: { in: memberIds } },
  });
  if (validMemberCount !== memberIds.length) return err("WBS 投入人员必须来自当前项目组成员");

  await prisma.$transaction(async (tx) => {
    await tx.projectGanttTaskLaborAssignment.deleteMany({ where: { taskId } });
    if (assignments.length > 0) {
      await tx.projectGanttTaskLaborAssignment.createMany({
        data: assignments.map((assignment) => ({ taskId, ...assignment })),
      });
    }
    await tx.operationHistory.create({
      data: {
        projectId: id,
        entityType: "PROJECT_GANTT_TASK_LABOR_ASSIGNMENT",
        entityId: taskId,
        actionType: "UPDATE",
        operator: user.displayName,
        detail: `更新 WBS 任务「${result.task.taskCode || result.task.taskName}」的 ${assignments.length} 条人员分工`,
      },
    });
  });
  const saved = await prisma.projectGanttTaskLaborAssignment.findMany({
    where: { taskId },
    include: { projectMember: { select: { id: true, personName: true, roleName: true } } },
    orderBy: [{ projectMember: { personName: "asc" } }, { createdAt: "asc" }],
  });
  return ok({ assignments: saved.map(serializeAssignment) });
}
