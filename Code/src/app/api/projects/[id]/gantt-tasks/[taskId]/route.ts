import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { ensureMutableProject, err, notFound, ok } from "@/lib/api-utils";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
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
  replaceGanttTaskDependencies,
  serializeGanttTaskList,
} from "@/lib/gantt-task-service";
import { synchronizeGanttTaskCategoriesAfterNameChange } from "@/lib/gantt-hierarchy";
import { applyGanttOwnerChange, applyGanttOwnerSet, GanttOwnerReadOnlyError } from "@/lib/gantt-owner-service";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return err("未登录", 401);
  if (!(await userHasPermission(user, "project-gantt:edit"))) return err("权限不足", 403);

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const existing = await prisma.projectGanttTask.findFirst({
    where: { id: taskId, projectId: id },
    include: { ownerLinks: { select: { projectMemberId: true } } },
  });
  if (!existing) return notFound("甘特任务");

  const body = await req.json() as Record<string, unknown>;
  const requestedTaskCategory = "taskCategory" in body
    ? String(body.taskCategory ?? "").trim()
    : existing.taskCategory;
  if (requestedTaskCategory !== existing.taskCategory) {
    return err("任务类别由任务层级自动生成，不允许直接修改");
  }
  const taskName = String("taskName" in body ? body.taskName ?? "" : existing.taskName).trim();
  const taskDescription = String(body.taskDescription ?? existing.taskDescription ?? "").trim() || "无";
  const requestedStartDate = String("startDate" in body ? body.startDate ?? "" : existing.startDate).trim();
  const durationDays = Number("durationDays" in body ? body.durationDays ?? 0 : existing.durationDays);
  if (requestedStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedStartDate)) return err("计划开始时间格式应为 YYYY-MM-DD");
  if (!isValidGanttDurationDays(durationDays)) return err("工期只能为空或以 0.5 天为单位填写");
  if (!requestedStartDate && durationDays > 0) return err("填写工期时需要计划开始时间");
  const calendarMode = await getProjectGanttCalendarMode(id);
  const startDate = requestedStartDate ? normalizeTaskStartDate(requestedStartDate, calendarMode) : "";
  const finishDate = startDate ? calculateTaskFinishDate(startDate, durationDays, calendarMode) : "";
  const actualStartDate = String("actualStartDate" in body ? body.actualStartDate ?? "" : existing.actualStartDate).trim();
  const actualEndDate = String("actualEndDate" in body ? body.actualEndDate ?? "" : existing.actualEndDate).trim();
  const estimatedWorkHours = estimatedHoursForDuration(durationDays);
  const requestedActualWorkHours = Number(body.actualWorkHours ?? existing.actualWorkHours);
  const actualWorkHours = roundGanttHours(requestedActualWorkHours);
  const progress = Number("progress" in body ? body.progress ?? 0 : existing.progress);
  const isMilestone = "isMilestone" in body ? Boolean(body.isMilestone) : existing.isMilestone;
  const predecessorTask = String("predecessorTask" in body ? body.predecessorTask ?? "" : existing.predecessorTask).trim();
  const remark = String(body.remark ?? existing.remark ?? "").trim();
  const dependencies = parseGanttDependencyInput(body);
  const hasDependencyInput = "predecessorDependencies" in body || "predecessorTaskIds" in body || "predecessorTaskId" in body;
  const budgetItemId = "budgetItemId" in body
    ? (body.budgetItemId ? String(body.budgetItemId) : null)
    : existing.budgetItemId;
  const hasOwnerIdsInput = "ownerMemberIds" in body || "ownerMemberId" in body;
  const ownerMemberIds = Array.isArray(body.ownerMemberIds)
    ? [...new Set(body.ownerMemberIds.map((value) => String(value).trim()).filter(Boolean))]
    : ("ownerMemberId" in body ? (body.ownerMemberId ? [String(body.ownerMemberId).trim()] : []) : null);
  const existingOwnerLinks = existing.ownerLinks ?? [];
  const existingOwnerMemberIds = existingOwnerLinks.length > 0
    ? existingOwnerLinks.map((link) => link.projectMemberId)
    : existing.ownerMemberId ? [existing.ownerMemberId] : [];
  const ownerMemberId = ownerMemberIds === null
    ? existing.ownerMemberId
    : ownerMemberIds.length === 1 ? ownerMemberIds[0] : null;
  const ownerChanged = hasOwnerIdsInput && (
    JSON.stringify([...(ownerMemberIds ?? existingOwnerMemberIds)].sort()) !== JSON.stringify([...existingOwnerMemberIds].sort())
    || body.ownerChangeMode === "BRANCH_REASSIGN"
  );

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
  if (ownerMemberIds && ownerMemberIds.length > 0) {
    const owners = await prisma.projectMember.findMany({ where: { id: { in: ownerMemberIds }, projectId: id }, select: { id: true } });
    if (owners.length !== ownerMemberIds.length) return err("负责人必须来自当前项目组成员");
  }

  try {
    await prisma.$transaction(async (tx) => {
      const baseData = {
        taskName,
        taskDescription,
        startDate,
        finishDate,
        durationDays,
        durationMinutes: Math.round(durationDays * 450),
        actualStartDate,
        actualEndDate,
        estimatedWorkHours,
        actualWorkHours,
        progress,
        isMilestone,
        budgetItemId,
        predecessorTask,
        remark,
        ...(("startDate" in body || "durationDays" in body || ownerChanged || hasDependencyInput)
          ? { resourceNotBeforeDate: "" }
          : {}),
        ...(!ownerChanged ? { ownerMemberId } : {}),
      };

      const updated = await tx.projectGanttTask.update({
        where: { id: taskId },
        data: baseData,
      });

      if (taskName !== existing.taskName) {
        const projectTasks = await tx.projectGanttTask.findMany({
          where: { projectId: id },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          select: { id: true, parentId: true, sortOrder: true, createdAt: true, taskCategory: true, taskName: true },
        });
        const synchronized = synchronizeGanttTaskCategoriesAfterNameChange(
          projectTasks,
          taskId,
          existing.taskName,
          taskName,
        );
        const previousCategoryById = new Map(projectTasks.map((item) => [item.id, item.taskCategory]));
        const categoryUpdates = synchronized.filter((item) => previousCategoryById.get(item.id) !== item.taskCategory);
        await Promise.all(categoryUpdates.map((item) => tx.projectGanttTask.update({
          where: { id: item.id },
          data: { taskCategory: item.taskCategory },
        })));
      }

      if (ownerChanged) {
        if (ownerMemberIds) {
          await applyGanttOwnerSet({
            tx,
            projectId: id,
            taskId,
            nextOwnerMemberIds: ownerMemberIds,
            allowBranchReassignment: body.ownerChangeMode === "BRANCH_REASSIGN",
          });
        } else {
          await applyGanttOwnerChange({
            tx,
            projectId: id,
            taskId,
            nextOwnerMemberId: ownerMemberId,
            allowBranchReassignment: body.ownerChangeMode === "BRANCH_REASSIGN",
          });
        }
      }
      if (hasDependencyInput) await replaceGanttTaskDependencies(tx, id, taskId, dependencies);
      return updated;
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (error) {
    if (error instanceof GanttOwnerReadOnlyError) return err(error.message, 409);
    throw error;
  }
  await recalculateProjectGanttSchedule(id, calendarMode);
  const normalizedTask = serializeGanttTaskList(await getOrderedGanttTasks(id)).find((item) => item.id === taskId);
  return normalizedTask ? ok(normalizedTask) : notFound("甘特任务");
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return err("未登录", 401);
  if (!(await userHasPermission(user, "project-gantt:delete"))) return err("权限不足", 403);

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
