import { NextRequest } from "next/server";

import { getUserFromRequest } from "@/lib/auth";
import { ensureMutableProject, err, notFound, ok, unauthorized } from "@/lib/api-utils";
import { calculateEarnedValue } from "@/lib/earned-value";
import { getOrderedGanttTasks, serializeGanttTask } from "@/lib/gantt-task-service";
import { prisma } from "@/lib/prisma";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();
  const project = await prisma.project.findUnique({ where: { id }, select: { id: true } });
  if (!project) return notFound("项目");

  const requestedDate = req.nextUrl.searchParams.get("statusDate")?.trim() ?? "";
  const statusDate = datePattern.test(requestedDate) ? requestedDate : new Date().toISOString().slice(0, 10);
  const tasks = (await getOrderedGanttTasks(id)).map(serializeGanttTask);
  return ok(calculateEarnedValue(tasks, statusDate));
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const body = await req.json() as { entries?: Array<{ taskId?: unknown; budgetAtCompletion?: unknown; actualCost?: unknown }> };
  if (!Array.isArray(body.entries)) return err("挣值任务成本数据格式不正确");
  const entries = body.entries.map((entry) => ({
    taskId: String(entry.taskId ?? "").trim(),
    budgetAtCompletion: Number(entry.budgetAtCompletion ?? 0),
    actualCost: Number(entry.actualCost ?? 0),
  }));
  if (entries.some((entry) => !entry.taskId || !Number.isFinite(entry.budgetAtCompletion) || entry.budgetAtCompletion < 0 || !Number.isFinite(entry.actualCost) || entry.actualCost < 0)) {
    return err("BAC 与 AC 必须为大于或等于 0 的数字");
  }

  const validTaskCount = await prisma.projectGanttTask.count({
    where: { projectId: id, id: { in: entries.map((entry) => entry.taskId) } },
  });
  if (validTaskCount !== new Set(entries.map((entry) => entry.taskId)).size) return err("包含不存在的项目任务");

  await prisma.$transaction([
    ...entries.map((entry) => prisma.projectGanttTask.update({
      where: { id: entry.taskId },
      data: { budgetAtCompletion: entry.budgetAtCompletion, actualCost: entry.actualCost },
    })),
    prisma.operationHistory.create({
      data: {
        projectId: id,
        entityType: "PROJECT_EARNED_VALUE",
        entityId: id,
        actionType: "UPDATE",
        operator: user.displayName,
        detail: `更新 ${entries.length} 个任务的挣值成本数据`,
      },
    }),
  ]);

  return ok({ updatedCount: entries.length });
}
