import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";
import { ensureMutableProject, err, notFound, ok, unauthorized } from "@/lib/api-utils";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const body = await req.json();
  const taskIds: string[] = Array.isArray(body.taskIds) ? body.taskIds.map((item: unknown) => String(item)) : [];
  if (taskIds.length === 0) return err("任务排序不能为空");

  const existingTasks = await prisma.projectGanttTask.findMany({
    where: { projectId: id, id: { in: taskIds } },
    select: { id: true },
  });
  if (existingTasks.length !== taskIds.length) return notFound("甘特任务");

  await prisma.$transaction(
    taskIds.map((taskId: string, index: number) => (
      prisma.projectGanttTask.update({
        where: { id: taskId },
        data: { sortOrder: index + 1 },
      })
    ))
  );

  return ok({ message: "甘特任务排序已更新" });
}
