import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";
import { ensureMutableProject, err, notFound, ok, unauthorized } from "@/lib/api-utils";
import { getOrderedGanttTasks, renumberProjectGanttTaskCodes, serializeGanttTask } from "@/lib/gantt-task-service";

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

  const body = await req.json();
  const taskCategory = String(body.taskCategory ?? "").trim();
  const taskName = String(body.taskName ?? "").trim();
  const startDate = String(body.startDate ?? "").trim();
  const durationDays = Number(body.durationDays);
  const actualStartDate = String(body.actualStartDate ?? "").trim();
  const actualEndDate = String(body.actualEndDate ?? "").trim();
  const progress = Number(body.progress ?? 0);
  const predecessorTask = String(body.predecessorTask ?? "").trim();
  const parentId = body.parentId ? String(body.parentId) : null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return err("计划开始时间格式应为 YYYY-MM-DD");
  if (actualStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(actualStartDate)) return err("实际开始时间格式应为 YYYY-MM-DD");
  if (actualEndDate && !/^\d{4}-\d{2}-\d{2}$/.test(actualEndDate)) return err("实际完成时间格式应为 YYYY-MM-DD");
  if (!Number.isInteger(durationDays) || durationDays <= 0) return err("任务周期必须为大于 0 的整数天数");
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) return err("当前进度必须为 0-100 的整数");
  if (parentId) {
    const parent = await prisma.projectGanttTask.findFirst({ where: { id: parentId, projectId: id } });
    if (!parent) return notFound("父级甘特任务");
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

    return tx.projectGanttTask.create({
      data: {
        projectId: id,
        parentId,
        taskCode: "",
        taskCategory,
        taskName,
        startDate,
        durationDays,
        actualStartDate,
        actualEndDate,
        progress,
        predecessorTask,
        sortOrder,
      },
    });
  });
  await renumberProjectGanttTaskCodes(id);
  const normalizedTask = await prisma.projectGanttTask.findUnique({ where: { id: task.id } });

  return ok(serializeGanttTask(normalizedTask ?? task), 201);
}
