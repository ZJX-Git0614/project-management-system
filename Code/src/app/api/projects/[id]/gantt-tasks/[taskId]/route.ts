import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";
import { ensureMutableProject, err, notFound, ok, unauthorized } from "@/lib/api-utils";
import {
  calculateTaskFinishDate,
  estimatedHoursForDuration,
  isValidGanttDurationDays,
  normalizeTaskStartDate,
  roundGanttHours,
} from "@/lib/gantt-calendar";
import {
  deleteGanttTaskSubtrees,
  GanttRevisionConflictError,
  getProjectGanttCalendarMode,
  getOrderedGanttTasks,
  parseGanttDependencyInput,
  recalculateProjectGanttSchedule,
  renumberProjectGanttTaskCodes,
  replaceGanttTaskDependencies,
  serializeGanttTask,
} from "@/lib/gantt-task-service";

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

  const body = await req.json() as Record<string, unknown>;
  const taskCategory = String(body.taskCategory ?? "").trim();
  const taskName = String(body.taskName ?? "").trim();
  const taskDescription = String(body.taskDescription ?? existing.taskDescription ?? "").trim();
  const requestedStartDate = String(body.startDate ?? "").trim();
  const durationDays = Number(body.durationDays ?? 0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedStartDate)) return err("计划开始时间格式应为 YYYY-MM-DD");
  if (!isValidGanttDurationDays(durationDays)) return err("工期只能为空或以 0.5 天为单位填写");
  const calendarMode = await getProjectGanttCalendarMode(id);
  const startDate = normalizeTaskStartDate(requestedStartDate, calendarMode);
  const finishDate = calculateTaskFinishDate(startDate, durationDays, calendarMode);
  const actualStartDate = String(body.actualStartDate ?? "").trim();
  const actualEndDate = String(body.actualEndDate ?? "").trim();
  const estimatedWorkHours = estimatedHoursForDuration(durationDays);
  const requestedActualWorkHours = Number(body.actualWorkHours ?? existing.actualWorkHours);
  const actualWorkHours = roundGanttHours(requestedActualWorkHours);
  const progress = Number(body.progress ?? 0);
  const predecessorTask = String(body.predecessorTask ?? "").trim();
  const remark = String(body.remark ?? existing.remark ?? "").trim();
  const dependencies = parseGanttDependencyInput(body);
  const hasDependencyInput = "predecessorDependencies" in body || "predecessorTaskIds" in body || "predecessorTaskId" in body;
  const budgetItemId = "budgetItemId" in body
    ? (body.budgetItemId ? String(body.budgetItemId) : null)
    : existing.budgetItemId;
  const ownerMemberId = "ownerMemberId" in body
    ? (body.ownerMemberId ? String(body.ownerMemberId) : null)
    : existing.ownerMemberId;

  if (durationDays > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(finishDate)) return err("计划完成时间格式应为 YYYY-MM-DD");
  if (finishDate && finishDate < startDate) return err("计划完成时间不能早于计划开始时间");
  if (actualStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(actualStartDate)) return err("实际开始时间格式应为 YYYY-MM-DD");
  if (actualEndDate && !/^\d{4}-\d{2}-\d{2}$/.test(actualEndDate)) return err("实际完成时间格式应为 YYYY-MM-DD");
  if (!Number.isFinite(requestedActualWorkHours) || requestedActualWorkHours < 0) return err("实际工时必须为大于或等于 0 的数字");
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) return err("当前进度必须为 0-100 的整数");
  if (budgetItemId) {
    const budgetItem = await prisma.projectBudgetItem.findFirst({ where: { id: budgetItemId, projectId: id }, select: { id: true } });
    if (!budgetItem) return notFound("预算条目");
  }
  if (ownerMemberId) {
    const owner = await prisma.projectMember.findFirst({ where: { id: ownerMemberId, projectId: id }, select: { id: true } });
    if (!owner) return err("负责人必须来自当前项目组成员");
  }

  const shouldRegroupByCategory = Boolean(taskCategory && taskCategory !== existing.taskCategory);

  const task = await prisma.$transaction(async (tx) => {
    const baseData = {
      taskCategory,
      taskName,
      taskDescription,
      ownerMemberId,
      startDate,
      finishDate,
      durationDays,
      durationMinutes: Math.round(durationDays * 450),
      actualStartDate,
      actualEndDate,
      estimatedWorkHours,
      actualWorkHours,
      progress,
      budgetItemId,
      predecessorTask,
      remark,
    };

    if (!shouldRegroupByCategory) {
      const updated = await tx.projectGanttTask.update({
        where: { id: taskId },
        data: baseData,
      });
      if (hasDependencyInput) await replaceGanttTaskDependencies(tx, id, taskId, dependencies);
      return updated;
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
      const updated = await tx.projectGanttTask.update({
        where: { id: taskId },
        data: baseData,
      });
      if (hasDependencyInput) await replaceGanttTaskDependencies(tx, id, taskId, dependencies);
      return updated;
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
    if (hasDependencyInput) await replaceGanttTaskDependencies(tx, id, taskId, dependencies);
    return updated;
  });
  if (shouldRegroupByCategory) {
    await renumberProjectGanttTaskCodes(id);
  }
  await recalculateProjectGanttSchedule(id, calendarMode);
  const normalizedTask = (await getOrderedGanttTasks(id)).find((item) => item.id === taskId);

  return ok(normalizedTask ? serializeGanttTask(normalizedTask) : task);
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

  try {
    const result = await deleteGanttTaskSubtrees({
      projectId: id,
      rootTaskIds: [taskId],
      operator: user.displayName,
      operatorUserId: user.userId,
    });
    return ok({ message: "甘特任务已删除", ...result });
  } catch (error) {
    if (error instanceof GanttRevisionConflictError) {
      return err(error.message, 409, error.code);
    }
    return err(error instanceof Error ? error.message : "删除失败");
  }
}
