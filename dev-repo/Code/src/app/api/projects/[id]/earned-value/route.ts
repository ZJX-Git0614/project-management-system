import { NextRequest } from "next/server";

import { authorizeProjectAccess } from "@/lib/project-authorization";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils"
import { getOrderedGanttTasks, serializeGanttTaskList } from "@/lib/gantt-task-service";
import { prisma } from "@/lib/prisma";
import {
  buildProjectEarnedValueAnalysis,
  normalizeTaskActualCostMode,
  TASK_ACTUAL_COST_MODES,
} from "@/lib/project-earned-value-analysis";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "earned-value:view")) return forbidden();
  const accessError = await authorizeProjectAccess(user, id);
  if (accessError) return accessError;
  const project = await prisma.project.findUnique({ where: { id }, select: { id: true, amountWan: true } });
  if (!project) return notFound("项目");

  const requestedDate = req.nextUrl.searchParams.get("statusDate")?.trim() ?? "";
  const statusDate = datePattern.test(requestedDate) ? requestedDate : new Date().toISOString().slice(0, 10);
  const [tasks, budgetItems, worklogs] = await Promise.all([
    getOrderedGanttTasks(id).then(serializeGanttTaskList),
    prisma.projectBudgetItem.findMany({
      where: { projectId: id },
      orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }],
      include: { category: { select: { name: true, kind: true } } },
    }),
    prisma.projectTaskWorklog.findMany({
      where: { projectId: id },
      select: { taskId: true, projectMemberId: true, actualHours: true, actualCostSnapshot: true },
    }),
  ]);
  const contractAmount = Math.max(0, project.amountWan * 10_000);
  const analysis = buildProjectEarnedValueAnalysis({
    tasks,
    budgetItems: budgetItems.map((item) => ({
      ...item,
      kind: item.category.kind,
      categoryName: item.category.name,
    })),
    contractAmount,
    statusDate,
    worklogs,
  });
  return ok({
    statusDate: analysis.statusDate,
    rows: analysis.rows,
    summary: analysis.summary,
    budgetItems: analysis.normalizedBudgetItems,
    budgetSummary: analysis.budgetSummary,
  });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "earned-value:edit")) return forbidden();
  const accessError = await authorizeProjectAccess(user, id);
  if (accessError) return accessError;
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const body = await req.json() as { entries?: Array<{
    taskId?: unknown;
    budgetAtCompletion?: unknown;
    actualCost?: unknown;
    actualCostMode?: unknown;
    budgetItemId?: unknown;
  }> };
  if (!Array.isArray(body.entries)) return err("挣值任务成本数据格式不正确");
  const entries = body.entries.map((entry) => {
    const requestedMode = typeof entry.actualCostMode === "string"
      ? entry.actualCostMode.trim().toUpperCase()
      : "";
    const actualCost = Number(entry.actualCost ?? 0);
    const actualCostMode = requestedMode
      ? normalizeTaskActualCostMode(requestedMode)
      : actualCost > 0 ? "LEGACY_MANUAL_TOTAL" : "AUTO_LABOR";
    return {
      taskId: String(entry.taskId ?? "").trim(),
      budgetAtCompletion: Number(entry.budgetAtCompletion ?? 0),
      actualCost,
      actualCostMode,
      requestedMode,
      budgetItemId: entry.budgetItemId ? String(entry.budgetItemId) : null,
    };
  });
  if (entries.some((entry) => entry.requestedMode && !TASK_ACTUAL_COST_MODES.includes(entry.requestedMode as typeof TASK_ACTUAL_COST_MODES[number]))) {
    return err("实际成本口径不合法");
  }
  if (entries.some((entry) => !entry.taskId || !Number.isFinite(entry.budgetAtCompletion) || entry.budgetAtCompletion < 0 || !Number.isFinite(entry.actualCost) || entry.actualCost < 0)) {
    return err("成本必须为大于或等于 0 的数字");
  }

  const validTaskCount = await prisma.projectGanttTask.count({
    where: { projectId: id, id: { in: entries.map((entry) => entry.taskId) } },
  });
  if (validTaskCount !== new Set(entries.map((entry) => entry.taskId)).size) return err("包含不存在的项目任务");
  const selectedBudgetItemIds = [...new Set(entries.map((entry) => entry.budgetItemId).filter((value): value is string => Boolean(value)))];
  if (selectedBudgetItemIds.length > 0) {
    const validBudgetItemCount = await prisma.projectBudgetItem.count({ where: { projectId: id, id: { in: selectedBudgetItemIds } } });
    if (validBudgetItemCount !== selectedBudgetItemIds.length) return err("包含不存在的预算条目");
  }

  await prisma.$transaction([
    ...entries.map((entry) => prisma.projectGanttTask.update({
      where: { id: entry.taskId },
      data: {
        budgetAtCompletion: entry.budgetAtCompletion,
        actualCost: entry.actualCostMode === "AUTO_LABOR" || entry.actualCostMode === "LEGACY_AUTO_TASK_RATE"
          ? 0
          : entry.actualCost,
        actualCostMode: entry.actualCostMode,
        budgetItemId: entry.budgetItemId,
      },
    })),
    prisma.operationHistory.create({
      data: {
        projectId: id,
        entityType: "PROJECT_EARNED_VALUE",
        entityId: id,
        actionType: "UPDATE",
        operator: user.displayName,
        detail: `更新 ${entries.length} 个任务的挣值预算关联与成本数据`,
      },
    }),
  ]);

  return ok({ updatedCount: entries.length });
}
