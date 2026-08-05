import { NextRequest } from "next/server";

import { getUserFromRequest } from "@/lib/auth";
import { ensureMutableProject, err, forbidden, notFound, ok, unauthorized, unauthorizedFromRequest } from "@/lib/api-utils";
import { calculateEarnedValue } from "@/lib/earned-value";
import { getOrderedGanttTasks, serializeGanttTaskList } from "@/lib/gantt-task-service";
import { prisma } from "@/lib/prisma";
import { manpowerHourlyCost, projectBudgetItemPlannedCost } from "@/lib/project-budget-cost";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();
  const project = await prisma.project.findUnique({ where: { id }, select: { id: true, amountWan: true } });
  if (!project) return notFound("项目");

  const requestedDate = req.nextUrl.searchParams.get("statusDate")?.trim() ?? "";
  const statusDate = datePattern.test(requestedDate) ? requestedDate : new Date().toISOString().slice(0, 10);
  const tasks = serializeGanttTaskList(await getOrderedGanttTasks(id));
  const budgetItems = await prisma.projectBudgetItem.findMany({
    where: { projectId: id },
    orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }],
    include: { category: { select: { name: true, kind: true } } },
  });
  const contractAmount = Math.max(0, project.amountWan * 10_000);
  const normalizedBudgetItems = budgetItems.map((item) => {
    const costInput = { ...item, kind: item.category.kind };
    return {
      id: item.id,
      title: item.title || item.person || item.groupName || item.category.name,
      categoryName: item.category.name,
      kind: item.category.kind,
      plannedCost: projectBudgetItemPlannedCost(costInput, contractAmount),
      hourlyCost: manpowerHourlyCost(costInput),
      plannedWorkHours: item.category.kind === "MANPOWER"
        ? Math.max(0, item.personMonths) * 21.75 * 8
        : 0,
    };
  });
  const budgetById = new Map(normalizedBudgetItems.map((item) => [item.id, item]));
  const parentIds = new Set(tasks.map((task) => task.parentId).filter((value): value is string => Boolean(value)));
  const leafTasks = tasks.filter((task) => !parentIds.has(task.id));
  const linkedTaskIdsByBudgetItem = new Map<string, string[]>();
  leafTasks.forEach((task) => {
    if (!task.budgetItemId || !budgetById.has(task.budgetItemId)) return;
    const linked = linkedTaskIdsByBudgetItem.get(task.budgetItemId) ?? [];
    linked.push(task.id);
    linkedTaskIdsByBudgetItem.set(task.budgetItemId, linked);
  });
  const linkedBudgetIds = new Set(linkedTaskIdsByBudgetItem.keys());
  const unlinkedBudgetTotal = normalizedBudgetItems
    .filter((item) => !linkedBudgetIds.has(item.id))
    .reduce((sum, item) => sum + item.plannedCost, 0);
  const unlinkedTasks = leafTasks.filter((task) => !task.budgetItemId && !(task.budgetAtCompletion && task.budgetAtCompletion > 0));
  const taskWeight = (task: typeof tasks[number]) => Math.max(0, task.estimatedWorkHours ?? 0) || Math.max(1, task.durationDays) * 8;
  const unlinkedWeightTotal = unlinkedTasks.reduce((sum, task) => sum + taskWeight(task), 0);
  const manpowerItems = normalizedBudgetItems.filter((item) => item.kind === "MANPOWER" && item.hourlyCost > 0);
  const manpowerPlannedHours = manpowerItems.reduce((sum, item) => sum + item.plannedWorkHours, 0);
  const blendedHourlyCost = manpowerPlannedHours > 0
    ? manpowerItems.reduce((sum, item) => sum + item.plannedCost, 0) / manpowerPlannedHours
    : 0;

  const analysisTasks = tasks.map((task) => {
    const includeInTotals = !parentIds.has(task.id);
    const linkedBudget = task.budgetItemId ? budgetById.get(task.budgetItemId) : undefined;
    const linkedTasks = linkedBudget ? linkedTaskIdsByBudgetItem.get(linkedBudget.id) ?? [] : [];
    const linkedWeightTotal = linkedTasks.reduce((sum, taskId) => {
      const linkedTask = leafTasks.find((item) => item.id === taskId);
      return sum + (linkedTask ? taskWeight(linkedTask) : 0);
    }, 0);
    const allocatedBudget = linkedBudget && includeInTotals
      ? linkedBudget.plannedCost * taskWeight(task) / Math.max(linkedWeightTotal, taskWeight(task))
      : includeInTotals && unlinkedTasks.some((item) => item.id === task.id)
        ? unlinkedBudgetTotal * taskWeight(task) / Math.max(unlinkedWeightTotal, taskWeight(task))
        : 0;
    const budgetAtCompletion = task.budgetAtCompletion && task.budgetAtCompletion > 0
      ? task.budgetAtCompletion
      : allocatedBudget;
    const actualCost = task.actualCost && task.actualCost > 0
      ? task.actualCost
      : linkedBudget?.kind === "MANPOWER" && linkedBudget.hourlyCost > 0
        ? (task.actualWorkHours ?? 0) * linkedBudget.hourlyCost
        : !linkedBudget && blendedHourlyCost > 0
          ? (task.actualWorkHours ?? 0) * blendedHourlyCost
          : 0;
    const budgetSource = task.budgetAtCompletion && task.budgetAtCompletion > 0
      ? "任务手工设定"
      : linkedBudget
        ? `${linkedBudget.categoryName} / ${linkedBudget.title}`
        : allocatedBudget > 0
          ? "项目预算按预计工时分摊"
          : "未关联预算";
    return { ...task, budgetAtCompletion, actualCost, budgetSource, includeInTotals };
  });
  const analysis = calculateEarnedValue(analysisTasks, statusDate);
  return ok({
    ...analysis,
    budgetItems: normalizedBudgetItems,
    budgetSummary: {
      projectBudget: normalizedBudgetItems.reduce((sum, item) => sum + item.plannedCost, 0),
      linkedBudgetItems: linkedBudgetIds.size,
      blendedHourlyCost,
    },
  });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "earned-value:edit")) return forbidden();
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const body = await req.json() as { entries?: Array<{ taskId?: unknown; budgetAtCompletion?: unknown; actualCost?: unknown; budgetItemId?: unknown }> };
  if (!Array.isArray(body.entries)) return err("挣值任务成本数据格式不正确");
  const entries = body.entries.map((entry) => ({
    taskId: String(entry.taskId ?? "").trim(),
    budgetAtCompletion: Number(entry.budgetAtCompletion ?? 0),
    actualCost: Number(entry.actualCost ?? 0),
    budgetItemId: entry.budgetItemId ? String(entry.budgetItemId) : null,
  }));
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
        actualCost: entry.actualCost,
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
