import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { ensureMutableProject, err, notFound, ok } from "@/lib/api-utils";
import { getGanttPlanMutationBlockReasonForActor } from "@/lib/gantt-baseline-service";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import {
  estimatedHoursForDuration,
  isValidGanttDurationDays,
  roundGanttHours,
} from "@/lib/gantt-calendar";
import {
  normalizeGanttCompletion,
  normalizeGanttHalfDay,
  normalizeGanttUserPriority,
  resolveGanttTaskPlan,
} from "@/lib/gantt-planning-rules";
import {
  getProjectGanttCalendarMode,
  getOrderedGanttTasks,
  parseGanttDependencyInput,
  recalculateProjectGanttSchedule,
  renumberProjectGanttTaskCodes,
  replaceGanttTaskDependencies,
  serializeGanttTaskList,
} from "@/lib/gantt-task-service";
import {
  resolveEffectiveGanttOwnerMemberIds,
  synchronizeGanttOwnerHierarchy,
} from "@/lib/gantt-owner-service";

const PARENT_BOUNDARY_MODES = new Set(["ROLLUP", "TARGET", "LOCKED"]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return err("未登录", 401);
  if (!(await userHasPermission(user, "project-gantt:view"))) return err("权限不足", 403);

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return notFound("项目");

  const tasks = await getOrderedGanttTasks(id);

  return ok(serializeGanttTaskList(tasks));
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return err("未登录", 401);
  if (!(await userHasPermission(user, "project-gantt:create"))) return err("权限不足", 403);

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;
  const baselineLockReason = await getGanttPlanMutationBlockReasonForActor({
    projectId: id,
    userId: user.userId,
    isAdministrator: user.assignedRoleNames.includes("管理员"),
  });
  if (baselineLockReason) return err(baselineLockReason, 409, "GANTT_BASELINE_LOCKED");

  const body = await req.json() as Record<string, unknown>;
  const taskName = String(body.taskName ?? "").trim();
  const taskDescription = String(body.taskDescription ?? "").trim() || "无";
  const requestedStartDate = String(body.startDate ?? "").trim();
  const requestedFinishDate = String(body.finishDate ?? "").trim();
  const requestedStartSlot = normalizeGanttHalfDay(body.startSlot);
  const requestedFinishSlot = normalizeGanttHalfDay(body.finishSlot, "PM");
  const durationDays = Number(body.durationDays ?? 0);
  if (!isValidGanttDurationDays(durationDays)) return err("工期只能为空或以 0.5 天为单位填写");
  const calendarMode = await getProjectGanttCalendarMode(id);
  const plan = resolveGanttTaskPlan({
    taskMode: body.taskMode,
    startDate: requestedStartDate,
    startSlot: requestedStartSlot,
    finishDate: requestedFinishDate,
    finishSlot: requestedFinishSlot,
    durationDays,
    mode: calendarMode,
  });
  if (plan.error) return err(plan.error);
  const actualStartDate = String(body.actualStartDate ?? "").trim();
  const actualEndDate = String(body.actualEndDate ?? "").trim();
  const actualStartSlot = normalizeGanttHalfDay(body.actualStartSlot);
  const actualFinishSlot = normalizeGanttHalfDay(body.actualFinishSlot, "PM");
  const estimatedWorkHours = estimatedHoursForDuration(plan.durationDays);
  const actualWorkHours = roundGanttHours(Number(body.actualWorkHours ?? 0));
  const requestedProgress = Number(body.progress ?? 0);
  const completion = normalizeGanttCompletion({
    progress: requestedProgress,
    actualStartDate,
    actualEndDate,
    today: new Date().toISOString().slice(0, 10),
  });
  const parentBoundaryMode = String(body.parentBoundaryMode ?? "ROLLUP").trim().toUpperCase();
  const schedulePriority = Number(body.schedulePriority ?? 500);
  const userPriority = normalizeGanttUserPriority(body.userPriority);
  const effortDriven = body.effortDriven === true;
  const parallelizable = body.parallelizable === true;
  const isMilestone = Boolean(body.isMilestone);
  const predecessorTask = String(body.predecessorTask ?? "").trim();
  const remark = String(body.remark ?? "").trim();
  const dependencies = parseGanttDependencyInput(body);
  const parentId = body.parentId ? String(body.parentId) : null;
  const requestedOwnerMemberIds = Array.isArray(body.ownerMemberIds)
    ? [...new Set(body.ownerMemberIds.map((value) => String(value).trim()).filter(Boolean))]
    : (body.ownerMemberId ? [String(body.ownerMemberId).trim()] : []);
  const budgetItemId = body.budgetItemId ? String(body.budgetItemId) : null;

  if (actualStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(actualStartDate)) return err("实际开始时间格式应为 YYYY-MM-DD");
  if (completion.error) return err(completion.error);
  if (!Number.isFinite(Number(body.actualWorkHours ?? 0)) || Number(body.actualWorkHours ?? 0) < 0) return err("实际工时必须为大于或等于 0 的数字");
  if (!PARENT_BOUNDARY_MODES.has(parentBoundaryMode)) return err("父任务边界方式无效");
  if (!Number.isInteger(schedulePriority) || schedulePriority < 0 || schedulePriority > 1000) {
    return err("排期优先级必须是 0 到 1000 的整数");
  }
  const parentTask = parentId
    ? await prisma.projectGanttTask.findFirst({
        where: { id: parentId, projectId: id },
        select: { id: true, taskCategory: true, taskName: true },
      })
    : null;
  if (parentId && !parentTask) return notFound("父级甘特任务");
  const taskCategory = parentTask
    ? parentTask.taskCategory.trim() || parentTask.taskName.trim()
    : taskName;
  if (budgetItemId) {
    const budgetItem = await prisma.projectBudgetItem.findFirst({ where: { id: budgetItemId, projectId: id }, select: { id: true } });
    if (!budgetItem) return notFound("预算条目");
  }
  if (requestedOwnerMemberIds.length > 0) {
    if (requestedOwnerMemberIds.length > 1) {
      return err("末级任务只能指定一名负责人；父级负责人由子任务自动汇总");
    }
    const owners = await prisma.projectMember.findMany({ where: { id: { in: requestedOwnerMemberIds }, projectId: id }, select: { id: true } });
    if (owners.length !== requestedOwnerMemberIds.length) return err("负责人必须来自当前项目组成员");
  }

  const siblings = await prisma.projectGanttTask.findMany({
    where: { projectId: id, parentId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { sortOrder: true, taskCategory: true },
  });
  const categorySiblings = taskCategory
    ? siblings.filter((task) => task.taskCategory === taskCategory)
    : [];
  const insertAfterSortOrder = categorySiblings.at(-1)?.sortOrder ?? siblings.at(-1)?.sortOrder ?? 0;
  const sortOrder = insertAfterSortOrder + 1;

  const task = await prisma.$transaction(async (tx) => {
    const inheritedOwnerMemberIds = parentId
      ? await resolveEffectiveGanttOwnerMemberIds({ tx, projectId: id, taskId: parentId })
      : [];
    // A new task is initially a leaf. A parent may aggregate several owners,
    // but a leaf must have exactly zero or one direct responsible person.
    const ownerMemberIds = requestedOwnerMemberIds.length > 0
      ? requestedOwnerMemberIds
      : inheritedOwnerMemberIds.length === 1 ? inheritedOwnerMemberIds : [];
    const ownerMemberId = ownerMemberIds.length === 1 ? ownerMemberIds[0] : null;
    await tx.projectGanttTask.updateMany({
      where: { projectId: id, parentId, sortOrder: { gte: sortOrder } },
      data: { sortOrder: { increment: 1 } },
    });

    const created = await tx.projectGanttTask.create({
      data: {
        projectId: id,
        parentId,
        ownerMemberId,
        ownerLinks: ownerMemberIds.length > 0
          ? { createMany: { data: ownerMemberIds.map((projectMemberId) => ({ projectMemberId })) } }
          : undefined,
        taskCode: "",
        taskCategory,
        taskName,
        taskDescription,
        startDate: plan.startDate,
        finishDate: plan.finishDate,
        durationDays: plan.durationDays,
        durationMinutes: Math.round(plan.durationDays * 450),
        actualStartDate: completion.actualStartDate,
        actualEndDate: completion.actualEndDate,
        startSlot: plan.startSlot,
        finishSlot: plan.finishSlot,
        actualStartSlot,
        actualFinishSlot,
        estimatedWorkHours,
        actualWorkHours,
        progress: completion.progress,
        taskMode: plan.taskMode,
        parentBoundaryMode,
        schedulePriority,
        userPriority,
        effectivePriority: userPriority,
        effortDriven,
        parallelizable,
        isMilestone,
        budgetItemId,
        predecessorTask,
        remark,
        sortOrder,
      },
    });
    await replaceGanttTaskDependencies(tx, id, created.id, dependencies);
    await synchronizeGanttOwnerHierarchy({ tx, projectId: id });
    await tx.project.update({ where: { id }, data: { ganttRevision: { increment: 1 } } });
    return created;
  });
  await renumberProjectGanttTaskCodes(id);
  await recalculateProjectGanttSchedule(id, calendarMode);
  const normalizedTask = serializeGanttTaskList(await getOrderedGanttTasks(id)).find((item) => item.id === task.id);
  if (!normalizedTask) return err("新增任务后读取失败", 500);

  return ok(normalizedTask, 201);
}
