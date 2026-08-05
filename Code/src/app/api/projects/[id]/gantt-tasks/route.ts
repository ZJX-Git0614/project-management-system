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

  const body = await req.json() as Record<string, unknown>;
  const taskName = String(body.taskName ?? "").trim();
  const taskDescription = String(body.taskDescription ?? "").trim() || "无";
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
  const actualWorkHours = roundGanttHours(Number(body.actualWorkHours ?? 0));
  const progress = Number(body.progress ?? 0);
  const isMilestone = Boolean(body.isMilestone);
  const predecessorTask = String(body.predecessorTask ?? "").trim();
  const remark = String(body.remark ?? "").trim();
  const dependencies = parseGanttDependencyInput(body);
  const parentId = body.parentId ? String(body.parentId) : null;
  const requestedOwnerMemberIds = Array.isArray(body.ownerMemberIds)
    ? [...new Set(body.ownerMemberIds.map((value) => String(value).trim()).filter(Boolean))]
    : (body.ownerMemberId ? [String(body.ownerMemberId).trim()] : []);
  const budgetItemId = body.budgetItemId ? String(body.budgetItemId) : null;

  if (durationDays > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(finishDate)) return err("计划完成时间格式应为 YYYY-MM-DD");
  if (finishDate && finishDate < startDate) return err("计划完成时间不能早于计划开始时间");
  if (actualStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(actualStartDate)) return err("实际开始时间格式应为 YYYY-MM-DD");
  if (actualEndDate && !/^\d{4}-\d{2}-\d{2}$/.test(actualEndDate)) return err("实际完成时间格式应为 YYYY-MM-DD");
  if (!Number.isFinite(Number(body.actualWorkHours ?? 0)) || Number(body.actualWorkHours ?? 0) < 0) return err("实际工时必须为大于或等于 0 的数字");
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) return err("当前进度必须为 0-100 的整数");
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
    const ownerMemberIds = requestedOwnerMemberIds.length > 0 ? requestedOwnerMemberIds : inheritedOwnerMemberIds;
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
        sortOrder,
      },
    });
    await replaceGanttTaskDependencies(tx, id, created.id, dependencies);
    await synchronizeGanttOwnerHierarchy({ tx, projectId: id });
    return created;
  });
  await renumberProjectGanttTaskCodes(id);
  await recalculateProjectGanttSchedule(id, calendarMode);
  const normalizedTask = serializeGanttTaskList(await getOrderedGanttTasks(id)).find((item) => item.id === task.id);
  if (!normalizedTask) return err("新增任务后读取失败", 500);

  return ok(normalizedTask, 201);
}
