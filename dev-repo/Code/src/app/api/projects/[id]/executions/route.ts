import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import {
  normalizeExecutionScopeLinks,
  normalizeExecutionStatus,
  normalizeExecutionType,
  projectExecutionInclude,
  serializeProjectExecution,
} from "@/lib/project-execution";

type RouteContext = { params: Promise<{ id: string }> };

const validateScopeLinks = async (
  projectId: string,
  scopeLinks: Array<{ ganttTaskId: string; relationType: "DIRECT" | "SUBTREE" }>,
) => {
  if (!scopeLinks.length) return [];
  const taskIds = scopeLinks.map((link) => link.ganttTaskId);
  const tasks = await prisma.projectGanttTask.findMany({
    where: { projectId, id: { in: taskIds } },
    select: { id: true },
  });
  return tasks.length === taskIds.length ? scopeLinks : null;
};

export async function GET(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:view")) return forbidden();

  const { id: projectId } = await params;
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) return notFound("项目");

  const executions = await prisma.projectExecution.findMany({
    where: { projectId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: projectExecutionInclude,
  });
  return ok(executions.map((execution) => serializeProjectExecution(execution)));
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:create")) return forbidden();

  const { id: projectId } = await params;
  const readOnly = await ensureMutableProject(projectId);
  if (readOnly) return readOnly;

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) return notFound("项目");

  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return err("阶段名称不能为空");
  if (name.length > 200) return err("阶段名称不能超过 200 个字符");

  const ownerMemberId = typeof body.ownerMemberId === "string" && body.ownerMemberId.trim()
    ? body.ownerMemberId
    : null;
  if (ownerMemberId) {
    const owner = await prisma.projectMember.findFirst({ where: { id: ownerMemberId, projectId }, select: { id: true } });
    if (!owner) return err("负责人不属于当前项目");
  }

  const scopeLinks = normalizeExecutionScopeLinks(body.scopeLinks, body.taskIds);
  if (await validateScopeLinks(projectId, scopeLinks) === null) return err("关联任务必须属于当前项目");

  const latest = await prisma.projectExecution.findFirst({
    where: { projectId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });

  const execution = await prisma.$transaction(async (tx) => {
    const created = await tx.projectExecution.create({
      data: {
        projectId,
        name,
        type: normalizeExecutionType(body.type),
        ownerMemberId,
        status: normalizeExecutionStatus(body.status),
        description: typeof body.description === "string" ? body.description.trim() : "",
        sortOrder: (latest?.sortOrder ?? -1) + 1,
        taskLinks: scopeLinks.length
          ? { createMany: { data: scopeLinks } }
          : undefined,
      },
      include: projectExecutionInclude,
    });
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "PROJECT_EXECUTION",
        entityId: created.id,
        actionType: "CREATE",
        operator: user.displayName,
        detail: `创建执行阶段：${created.name}`,
      },
    });
    return created;
  });

  return ok(serializeProjectExecution(execution), 201);
}
