import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:create")) return forbidden();

  const { id: projectId } = await params;
  const readOnly = await ensureMutableProject(projectId);
  if (readOnly) return readOnly;
  const [project, existingCount, rootTasks] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }),
    prisma.projectExecution.count({ where: { projectId } }),
    prisma.projectGanttTask.findMany({
      where: { projectId, parentId: null },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, taskName: true, taskCode: true },
    }),
  ]);
  if (!project) return notFound("项目");
  if (existingCount > 0) return err("项目已有执行阶段，不能重复按 WBS 初始化", 409, "EXECUTION_EXISTS");
  if (rootTasks.length === 0) return err("当前项目没有一级 WBS，无法生成执行阶段");

  const created = await prisma.$transaction(async (tx) => {
    const stages = await tx.projectExecution.createManyAndReturn({
      data: rootTasks.map((task, sortOrder) => ({
        projectId,
        name: task.taskName || task.taskCode || `阶段 ${sortOrder + 1}`,
        type: "WORK_PACKAGE",
        status: "PLANNED",
        description: "由一级 WBS 初始化，范围自动包含该节点的全部子任务。",
        sortOrder,
      })),
      select: { id: true, name: true },
    });
    await tx.projectExecutionTask.createMany({
      data: stages.map((stage, index) => ({
        executionId: stage.id,
        ganttTaskId: rootTasks[index].id,
        relationType: "SUBTREE",
      })),
    });
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "PROJECT_EXECUTION",
        entityId: projectId,
        actionType: "INITIALIZE",
        operator: user.displayName,
        detail: `按 ${rootTasks.length} 个一级 WBS 初始化项目执行阶段：${stages.map((stage) => stage.name).join("、")}`,
      },
    });
    return stages;
  });
  return ok({ created });
}
