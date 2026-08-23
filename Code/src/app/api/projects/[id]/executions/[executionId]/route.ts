import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import {
  normalizeExecutionStatus,
  normalizeExecutionType,
  normalizeTaskIds,
  projectExecutionInclude,
  serializeProjectExecution,
} from "@/lib/project-execution";

type RouteContext = { params: Promise<{ id: string; executionId: string }> };

const validateTaskIds = async (projectId: string, taskIds: string[]) => {
  if (!taskIds.length) return true;
  const count = await prisma.projectGanttTask.count({ where: { projectId, id: { in: taskIds } } });
  return count === taskIds.length;
};

const loadExecution = (projectId: string, executionId: string) => prisma.projectExecution.findUnique({
  where: { id: executionId, projectId },
  include: projectExecutionInclude,
});

export async function GET(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:view")) return forbidden();

  const { id: projectId, executionId } = await params;
  const execution = await loadExecution(projectId, executionId);
  return execution ? ok(serializeProjectExecution(execution)) : notFound("执行阶段");
}

export async function PUT(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:edit")) return forbidden();

  const { id: projectId, executionId } = await params;
  const readOnly = await ensureMutableProject(projectId);
  if (readOnly) return readOnly;
  const current = await loadExecution(projectId, executionId);
  if (!current) return notFound("执行阶段");

  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : current.name;
  if (!name) return err("阶段名称不能为空");
  if (name.length > 200) return err("阶段名称不能超过 200 个字符");

  const ownerMemberId = body.ownerMemberId === null || body.ownerMemberId === ""
    ? null
    : typeof body.ownerMemberId === "string" ? body.ownerMemberId : current.ownerMemberId;
  if (ownerMemberId) {
    const owner = await prisma.projectMember.findFirst({ where: { id: ownerMemberId, projectId }, select: { id: true } });
    if (!owner) return err("负责人不属于当前项目");
  }

  const hasTaskIds = Object.prototype.hasOwnProperty.call(body, "taskIds");
  const taskIds = hasTaskIds ? normalizeTaskIds(body.taskIds) : current.taskLinks.map((link) => link.ganttTaskId);
  if (!await validateTaskIds(projectId, taskIds)) return err("关联任务必须属于当前项目");

  const execution = await prisma.$transaction(async (tx) => {
    const updated = await tx.projectExecution.update({
      where: { id: executionId, projectId },
      data: {
        name,
        type: typeof body.type === "undefined" ? current.type : normalizeExecutionType(body.type),
        ownerMemberId,
        status: typeof body.status === "undefined" ? current.status : normalizeExecutionStatus(body.status),
        description: typeof body.description === "undefined" ? current.description : String(body.description).trim(),
        taskLinks: hasTaskIds
          ? {
              deleteMany: {},
              ...(taskIds.length ? { createMany: { data: taskIds.map((ganttTaskId) => ({ ganttTaskId })) } } : {}),
            }
          : undefined,
      },
      include: projectExecutionInclude,
    });
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "PROJECT_EXECUTION",
        entityId: executionId,
        actionType: "UPDATE",
        operator: user.displayName,
        detail: `更新执行阶段：${updated.name}`,
      },
    });
    return updated;
  });

  return ok(serializeProjectExecution(execution));
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:delete")) return forbidden();

  const { id: projectId, executionId } = await params;
  const readOnly = await ensureMutableProject(projectId);
  if (readOnly) return readOnly;
  const current = await loadExecution(projectId, executionId);
  if (!current) return notFound("执行阶段");

  await prisma.$transaction(async (tx) => {
    await tx.projectExecution.delete({ where: { id: executionId, projectId } });
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "PROJECT_EXECUTION",
        entityId: executionId,
        actionType: "DELETE",
        operator: user.displayName,
        detail: `删除执行阶段：${current.name}`,
      },
    });
  });
  return ok({ id: executionId });
}
