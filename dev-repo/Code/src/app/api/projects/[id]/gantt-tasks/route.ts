import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";
import { ensureMutableProject, err, notFound, ok, unauthorized } from "@/lib/api-utils";
import { getNextGanttTaskCode, getOrderedGanttTasks, serializeGanttTask } from "@/lib/gantt-task-service";

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
  const predecessorTask = String(body.predecessorTask ?? "").trim();
  const parentId = body.parentId ? String(body.parentId) : null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return err("开始时间格式应为 YYYY-MM-DD");
  if (!Number.isInteger(durationDays) || durationDays <= 0) return err("任务周期必须为大于 0 的整数天数");
  if (parentId) {
    const parent = await prisma.projectGanttTask.findFirst({ where: { id: parentId, projectId: id } });
    if (!parent) return notFound("父级甘特任务");
  }

  const siblingLastTask = await prisma.projectGanttTask.findFirst({
    where: { projectId: id, parentId },
    orderBy: [{ sortOrder: "desc" }, { createdAt: "desc" }],
  });
  const taskCode = await getNextGanttTaskCode(id, parentId);

  const task = await prisma.projectGanttTask.create({
    data: {
      projectId: id,
      parentId,
      taskCode,
      taskCategory,
      taskName,
      startDate,
      durationDays,
      predecessorTask,
      sortOrder: (siblingLastTask?.sortOrder ?? 0) + 1,
    },
  });

  return ok(serializeGanttTask(task), 201);
}
