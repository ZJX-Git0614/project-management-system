import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { authorizeProjectAccess } from "@/lib/project-authorization";
import { manpowerHourlyCost } from "@/lib/project-budget-cost";
import { normalizeTaskActualCostMode } from "@/lib/project-earned-value-analysis";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const serializeWorklog = (worklog: {
  id: string;
  projectId: string;
  taskId: string;
  projectMemberId: string;
  budgetLaborAllocationId: string | null;
  workDate: string;
  actualHours: number;
  hourlyCostSnapshot: number;
  actualCostSnapshot: number;
  source: string;
  note: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  projectMember: { id: string; personName: string; roleName: string };
}, canViewCost: boolean) => ({
  id: worklog.id,
  projectId: worklog.projectId,
  taskId: worklog.taskId,
  projectMemberId: worklog.projectMemberId,
  budgetLaborAllocationId: worklog.budgetLaborAllocationId,
  workDate: worklog.workDate,
  actualHours: worklog.actualHours,
  hourlyCostSnapshot: canViewCost ? worklog.hourlyCostSnapshot : null,
  actualCostSnapshot: canViewCost ? worklog.actualCostSnapshot : null,
  source: worklog.source,
  note: worklog.note,
  createdBy: worklog.createdBy,
  createdAt: worklog.createdAt.toISOString(),
  updatedAt: worklog.updatedAt.toISOString(),
  projectMember: worklog.projectMember,
});

const getLeafTask = async (projectId: string, taskId: string) => {
  const task = await prisma.projectGanttTask.findFirst({
    where: { id: taskId, projectId },
    include: {
      budgetItem: {
        include: {
          category: { select: { kind: true } },
          laborAllocations: { select: { id: true, projectMemberId: true, plannedHourlyCost: true } },
        },
      },
      laborAssignments: { select: { projectMemberId: true } },
    },
  });
  if (!task) return { error: notFound("甘特任务") } as const;
  const childCount = await prisma.projectGanttTask.count({ where: { projectId, parentId: taskId } });
  if (childCount > 0) return { error: err("父级汇总任务不能登记实际工时") } as const;
  return { task } as const;
};

// GET /api/projects/[id]/gantt-tasks/[taskId]/worklogs
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:view")) return forbidden();
  const accessError = await authorizeProjectAccess(user, id);
  if (accessError) return accessError;
  const result = await getLeafTask(id, taskId);
  if ("error" in result) return result.error;
  const [canViewCost, worklogs] = await Promise.all([
    userHasPermission(user, "earned-value:view"),
    prisma.projectTaskWorklog.findMany({
      where: { projectId: id, taskId },
      include: { projectMember: { select: { id: true, personName: true, roleName: true } } },
      orderBy: [{ workDate: "desc" }, { createdAt: "desc" }],
    }),
  ]);
  return ok({
    task: {
      id: result.task.id,
      taskCode: result.task.taskCode,
      taskName: result.task.taskName,
      actualCostMode: normalizeTaskActualCostMode(result.task.actualCostMode),
    },
    canViewCost,
    worklogs: worklogs.map((worklog) => serializeWorklog(worklog, canViewCost)),
  });
}

// POST /api/projects/[id]/gantt-tasks/[taskId]/worklogs
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:edit")) return forbidden();
  const accessError = await authorizeProjectAccess(user, id);
  if (accessError) return accessError;
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const result = await getLeafTask(id, taskId);
  if ("error" in result) return result.error;
  const actualCostMode = normalizeTaskActualCostMode(result.task.actualCostMode);
  if (actualCostMode !== "AUTO_LABOR" && actualCostMode !== "AUTO_PLUS_ADJUSTMENT") {
    return err("该任务仍使用历史成本口径，请先在挣值分析中切换为“按人员工时自动计算”", 409, "TASK_COST_MODE_LEGACY");
  }
  const body = await req.json() as Record<string, unknown>;
  const projectMemberId = String(body.projectMemberId ?? "").trim();
  const workDate = String(body.workDate ?? "").trim();
  const actualHours = Number(body.actualHours ?? 0);
  const note = String(body.note ?? "").trim().slice(0, 500);
  if (!projectMemberId) return err("登记工时的项目成员不能为空");
  if (!datePattern.test(workDate)) return err("工时日期格式应为 YYYY-MM-DD");
  if (!Number.isFinite(actualHours) || actualHours <= 0 || actualHours > 24) {
    return err("单条实际工时必须大于 0 且不超过 24 小时");
  }
  const member = await prisma.projectMember.findFirst({
    where: { id: projectMemberId, projectId: id },
    select: { id: true, personName: true, roleName: true },
  });
  if (!member) return err("实际工时人员必须来自当前项目组成员");
  const matchingBudgetAllocation = result.task.budgetItem?.laborAllocations
    .find((allocation) => allocation.projectMemberId === projectMemberId);
  const linkedToTask = result.task.ownerMemberId === projectMemberId
    || result.task.laborAssignments.some((assignment) => assignment.projectMemberId === projectMemberId)
    || Boolean(matchingBudgetAllocation);
  if (!linkedToTask) return err("该人员尚未分配到当前 WBS 任务，请先维护 WBS 人员分工");
  const budgetItem = result.task.budgetItem;
  const defaultHourlyCost = budgetItem?.category.kind === "MANPOWER"
    ? manpowerHourlyCost({ ...budgetItem, kind: budgetItem.category.kind })
    : 0;
  const hourlyCostSnapshot = matchingBudgetAllocation?.plannedHourlyCost && matchingBudgetAllocation.plannedHourlyCost > 0
    ? matchingBudgetAllocation.plannedHourlyCost
    : defaultHourlyCost;
  if (!(hourlyCostSnapshot > 0)) {
    return err("当前 WBS 未关联可用的人力成本率，请先在对应人力预算中维护人员分摊与小时成本", 409, "TASK_LABOR_RATE_MISSING");
  }
  const actualCostSnapshot = actualHours * hourlyCostSnapshot;
  const worklog = await prisma.$transaction(async (tx) => {
    const created = await tx.projectTaskWorklog.create({
      data: {
        projectId: id,
        taskId,
        projectMemberId,
        budgetLaborAllocationId: matchingBudgetAllocation?.id ?? null,
        workDate,
        actualHours,
        hourlyCostSnapshot,
        actualCostSnapshot,
        source: "MANUAL",
        note,
        createdBy: user.displayName,
      },
      include: { projectMember: { select: { id: true, personName: true, roleName: true } } },
    });
    const totals = await tx.projectTaskWorklog.aggregate({
      where: { projectId: id, taskId },
      _sum: { actualHours: true },
    });
    await tx.projectGanttTask.update({
      where: { id: taskId },
      data: { actualWorkHours: Math.max(0, totals._sum.actualHours ?? 0) },
    });
    await tx.operationHistory.create({
      data: {
        projectId: id,
        entityType: "PROJECT_TASK_WORKLOG",
        entityId: created.id,
        actionType: "CREATE",
        operator: user.displayName,
        detail: `登记 ${member.personName} 在 WBS 任务「${result.task.taskCode || result.task.taskName}」的 ${actualHours} 小时实际工时`,
      },
    });
    return created;
  });
  const canViewCost = await userHasPermission(user, "earned-value:view");
  return ok({ worklog: serializeWorklog(worklog, canViewCost) }, 201);
}
