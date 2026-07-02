import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";
import { ensureMutableProject, err, notFound, ok, unauthorized } from "@/lib/api-utils";

const serializeTask = (task: {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  projectId: string;
  taskCategory: string;
  taskName: string;
  startDate: string;
  durationDays: number;
  predecessorTask: string;
  sortOrder: number;
}) => ({
  ...task,
  createdAt: task.createdAt.toISOString(),
  updatedAt: task.updatedAt.toISOString(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return notFound("项目");

  const tasks = await prisma.projectGanttTask.findMany({
    where: { projectId: id },
    orderBy: [{ sortOrder: "asc" }, { startDate: "asc" }, { createdAt: "asc" }],
  });

  return ok(tasks.map(serializeTask));
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

  if (!taskCategory) return err("任务类别不能为空");
  if (!taskName) return err("任务名称不能为空");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return err("开始时间格式应为 YYYY-MM-DD");
  if (!Number.isInteger(durationDays) || durationDays <= 0) return err("任务周期必须为大于 0 的整数天数");

  const lastTask = await prisma.projectGanttTask.findFirst({
    where: { projectId: id },
    orderBy: [{ sortOrder: "desc" }, { createdAt: "desc" }],
  });

  const task = await prisma.projectGanttTask.create({
    data: {
      projectId: id,
      taskCategory,
      taskName,
      startDate,
      durationDays,
      predecessorTask,
      sortOrder: (lastTask?.sortOrder ?? 0) + 1,
    },
  });

  return ok(serializeTask(task), 201);
}
