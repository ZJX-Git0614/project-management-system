import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";
import { ensureMutableProject, err, notFound, ok, unauthorized } from "@/lib/api-utils";
import {
  calculateTaskFinishDate,
  estimatedHoursForDuration,
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
  serializeGanttTask,
} from "@/lib/gantt-task-service";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return notFound("项目");

  const tasks = await getOrderedGanttTasks(id);

  return ok(tasks.map(serializeGanttTask));
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const body = await req.json() as Record<string, unknown>;
  const taskCategory = String(body.taskCategory ?? "").trim();
  const taskName = String(body.taskName ?? "").trim();
  const requestedStartDate = String(body.startDate ?? "").trim();
  const durationDays = Number(body.durationDays);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedStartDate)) return err("计划开始时间格式应为 YYYY-MM-DD");
  if (!Number.isInteger(durationDays) || durationDays <= 0) return err("任务周期必须为大于 0 的整数天数");
  const calendarMode = await getProjectGanttCalendarMode(id);
  const startDate = normalizeTaskStartDate(requestedStartDate, calendarMode);
  const finishDate = calculateTaskFinishDate(startDate, durationDays, calendarMode);
  const actualStartDate = String(body.actualStartDate ?? "").trim();
  const actualEndDate = String(body.actualEndDate ?? "").trim();
  const estimatedWorkHours = estimatedHoursForDuration(durationDays);
  const actualWorkHours = roundGanttHours(Number(body.actualWorkHours ?? 0));
  const progress = Number(body.progress ?? 0);
  const predecessorTask = String(body.predecessorTask ?? "").trim();
  const dependencies = parseGanttDependencyInput(body);
  const parentId = body.parentId ? String(body.parentId) : null;
  const ownerMemberId = body.ownerMemberId ? String(body.ownerMemberId) : null;
  const budgetItemId = body.budgetItemId ? String(body.budgetItemId) : null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(finishDate)) return err("计划完成时间格式应为 YYYY-MM-DD");
  if (finishDate < startDate) return err("计划完成时间不能早于计划开始时间");
  if (actualStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(actualStartDate)) return err("实际开始时间格式应为 YYYY-MM-DD");
  if (actualEndDate && !/^\d{4}-\d{2}-\d{2}$/.test(actualEndDate)) return err("实际完成时间格式应为 YYYY-MM-DD");
  if (!Number.isFinite(Number(body.actualWorkHours ?? 0)) || Number(body.actualWorkHours ?? 0) < 0) return err("实际工时必须为大于或等于 0 的数字");
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) return err("当前进度必须为 0-100 的整数");
  if (parentId) {
    const parent = await prisma.projectGanttTask.findFirst({ where: { id: parentId, projectId: id } });
    if (!parent) return notFound("父级甘特任务");
  }
  if (budgetItemId) {
    const budgetItem = await prisma.projectBudgetItem.findFirst({ where: { id: budgetItemId, projectId: id }, select: { id: true } });
    if (!budgetItem) return notFound("预算条目");
  }
  if (ownerMemberId) {
    const owner = await prisma.projectMember.findFirst({ where: { id: ownerMemberId, projectId: id }, select: { id: true } });
    if (!owner) return err("负责人必须来自当前项目组成员");
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
    await tx.projectGanttTask.updateMany({
      where: { projectId: id, parentId, sortOrder: { gte: sortOrder } },
      data: { sortOrder: { increment: 1 } },
    });

    const created = await tx.projectGanttTask.create({
      data: {
        projectId: id,
        parentId,
        ownerMemberId,
        taskCode: "",
        taskCategory,
        taskName,
        startDate,
        finishDate,
        durationDays,
        durationMinutes: durationDays * 450,
        actualStartDate,
        actualEndDate,
        estimatedWorkHours,
        actualWorkHours,
        progress,
        budgetItemId,
        predecessorTask,
        sortOrder,
      },
    });
    await replaceGanttTaskDependencies(tx, id, created.id, dependencies);
    return created;
  });
  await renumberProjectGanttTaskCodes(id);
  await recalculateProjectGanttSchedule(id, calendarMode);
  const normalizedTask = (await getOrderedGanttTasks(id)).find((item) => item.id === task.id);

  return ok(normalizedTask ? serializeGanttTask(normalizedTask) : task, 201);
}
