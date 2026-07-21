import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";
import { ensureMutableProject, err, notFound, ok, unauthorized } from "@/lib/api-utils";
import { renumberProjectGanttTaskCodes, serializeGanttTask } from "@/lib/gantt-task-service";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const existing = await prisma.projectGanttTask.findFirst({ where: { id: taskId, projectId: id } });
  if (!existing) return notFound("甘特任务");

  const body = await req.json();
  const taskCategory = String(body.taskCategory ?? "").trim();
  const taskName = String(body.taskName ?? "").trim();
  const startDate = String(body.startDate ?? "").trim();
  const durationDays = Number(body.durationDays);
  const actualStartDate = String(body.actualStartDate ?? "").trim();
  const actualEndDate = String(body.actualEndDate ?? "").trim();
  const progress = Number(body.progress ?? 0);
  const predecessorTask = String(body.predecessorTask ?? "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return err("计划开始时间格式应为 YYYY-MM-DD");
  if (actualStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(actualStartDate)) return err("实际开始时间格式应为 YYYY-MM-DD");
  if (actualEndDate && !/^\d{4}-\d{2}-\d{2}$/.test(actualEndDate)) return err("实际完成时间格式应为 YYYY-MM-DD");
  if (!Number.isInteger(durationDays) || durationDays <= 0) return err("任务周期必须为大于 0 的整数天数");
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) return err("当前进度必须为 0-100 的整数");

  const shouldRegroupByCategory = Boolean(taskCategory && taskCategory !== existing.taskCategory);

  const task = await prisma.$transaction(async (tx) => {
    const baseData = {
      taskCategory,
      taskName,
      startDate,
      durationDays,
      actualStartDate,
      actualEndDate,
      progress,
      predecessorTask,
    };

    if (!shouldRegroupByCategory) {
      return tx.projectGanttTask.update({
        where: { id: taskId },
        data: baseData,
      });
    }

    const siblings = await tx.projectGanttTask.findMany({
      where: { projectId: id, parentId: existing.parentId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, taskCategory: true },
    });
    const remainingSiblings = siblings.filter((item) => item.id !== taskId);
    let insertAfterIndex = -1;
    remainingSiblings.forEach((item, index) => {
      if (item.taskCategory === taskCategory) insertAfterIndex = index;
    });

    if (insertAfterIndex < 0) {
      return tx.projectGanttTask.update({
        where: { id: taskId },
        data: baseData,
      });
    }

    const orderedIds = remainingSiblings.map((item) => item.id);
    orderedIds.splice(insertAfterIndex + 1, 0, taskId);

    const updated = await tx.projectGanttTask.update({
      where: { id: taskId },
      data: baseData,
    });
    await Promise.all(
      orderedIds.map((orderedId, index) => (
        tx.projectGanttTask.update({
          where: { id: orderedId },
          data: { sortOrder: index + 1 },
        })
      ))
    );
    return updated;
  });
  if (shouldRegroupByCategory) {
    await renumberProjectGanttTaskCodes(id);
  }
  const normalizedTask = await prisma.projectGanttTask.findUnique({ where: { id: taskId } });

  return ok(serializeGanttTask(normalizedTask ?? task));
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const existing = await prisma.projectGanttTask.findFirst({ where: { id: taskId, projectId: id } });
  if (!existing) return notFound("甘特任务");

  await prisma.projectGanttTask.delete({ where: { id: taskId } });
  return ok({ message: "甘特任务已删除" });
}
