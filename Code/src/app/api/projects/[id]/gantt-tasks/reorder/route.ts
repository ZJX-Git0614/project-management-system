import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { ensureMutableProject, err, notFound, ok } from "@/lib/api-utils";
import { getGanttPlanMutationBlockReasonForActor } from "@/lib/gantt-baseline-service";
import { renumberProjectGanttTaskCodes } from "@/lib/gantt-task-service";
import { requireUser, userHasPermission } from "@/lib/server-auth";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser(req);
  if ("status" in user) return user;
  if (!(await userHasPermission(user, "project-gantt:edit"))) return err("权限不足", 403);

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;
  const baselineLockReason = await getGanttPlanMutationBlockReasonForActor({
    projectId: id,
    userId: user.userId,
    isAdministrator: user.assignedRoleNames.includes("管理员"),
  });
  if (baselineLockReason) return err(baselineLockReason, 409, "GANTT_BASELINE_LOCKED");

  const body = await req.json();
  const taskIds: string[] = Array.isArray(body.taskIds) ? body.taskIds.map((item: unknown) => String(item)) : [];
  if (taskIds.length === 0) return err("任务排序不能为空");

  const existingTasks = await prisma.projectGanttTask.findMany({
    where: { projectId: id, id: { in: taskIds } },
    select: { id: true },
  });
  if (existingTasks.length !== taskIds.length) return notFound("甘特任务");

  await prisma.$transaction([
    ...taskIds.map((taskId: string, index: number) => (
      prisma.projectGanttTask.update({
        where: { id: taskId },
        data: { sortOrder: index + 1 },
      })
    )),
    prisma.project.update({
      where: { id },
      data: { ganttRevision: { increment: 1 } },
    }),
  ]);
  await renumberProjectGanttTaskCodes(id);

  return ok({ message: "甘特任务排序已更新" });
}
