import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { authorizeProjectAccess } from "@/lib/project-authorization";
import { manpowerHourlyCost } from "@/lib/project-budget-cost";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

const serializeMember = (member: { id: string; personName: string; roleName: string }) => ({
  id: member.id,
  personName: member.personName,
  roleName: member.roleName,
});

const serializeAllocation = (allocation: {
  id: string;
  projectId: string;
  budgetItemId: string;
  projectMemberId: string;
  plannedHours: number;
  plannedHourlyCost: number;
  remark: string;
  createdAt: Date;
  updatedAt: Date;
  projectMember: { id: string; personName: string; roleName: string };
}) => ({
  id: allocation.id,
  projectId: allocation.projectId,
  budgetItemId: allocation.budgetItemId,
  projectMemberId: allocation.projectMemberId,
  plannedHours: allocation.plannedHours,
  plannedHourlyCost: allocation.plannedHourlyCost,
  plannedCost: allocation.plannedHours * allocation.plannedHourlyCost,
  remark: allocation.remark,
  createdAt: allocation.createdAt.toISOString(),
  updatedAt: allocation.updatedAt.toISOString(),
  projectMember: serializeMember(allocation.projectMember),
});

const getBudgetItem = async (projectId: string, itemId: string) => {
  const item = await prisma.projectBudgetItem.findFirst({
    where: { id: itemId, projectId },
    include: { category: { select: { id: true, name: true, kind: true } } },
  });
  if (!item) return { error: notFound("预算条目") } as const;
  if (item.category.kind !== "MANPOWER") return { error: err("只有人力型预算条目可以分配到项目成员") } as const;
  return { item } as const;
};

// GET /api/projects/[id]/budget-items/[itemId]/labor-allocations
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const { id, itemId } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-budget:view")) return forbidden();
  const accessError = await authorizeProjectAccess(user, id);
  if (accessError) return accessError;

  const result = await getBudgetItem(id, itemId);
  if ("error" in result) return result.error;
  const [allocations, members] = await Promise.all([
    prisma.projectBudgetLaborAllocation.findMany({
      where: { budgetItemId: itemId, projectId: id },
      include: { projectMember: { select: { id: true, personName: true, roleName: true } } },
      orderBy: [{ projectMember: { personName: "asc" } }, { createdAt: "asc" }],
    }),
    prisma.projectMember.findMany({
      where: { projectId: id },
      select: { id: true, personName: true, roleName: true },
      orderBy: [{ personName: "asc" }, { createdAt: "asc" }],
    }),
  ]);
  const defaultHourlyCost = manpowerHourlyCost({ ...result.item, kind: result.item.category.kind });
  return ok({
    budgetItem: {
      id: result.item.id,
      title: result.item.title || result.item.person || result.item.groupName || result.item.category.name,
      categoryName: result.item.category.name,
      plannedHours: result.item.personMonths * 21.75 * 8,
      defaultHourlyCost,
    },
    members: members.map(serializeMember),
    allocations: allocations.map(serializeAllocation),
  });
}

// PUT /api/projects/[id]/budget-items/[itemId]/labor-allocations
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const { id, itemId } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-budget:edit")) return forbidden();
  const accessError = await authorizeProjectAccess(user, id);
  if (accessError) return accessError;
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const result = await getBudgetItem(id, itemId);
  if ("error" in result) return result.error;
  const body = await req.json() as { allocations?: unknown };
  if (!Array.isArray(body.allocations)) return err("人员预算分摊数据格式不正确");
  const defaultHourlyCost = manpowerHourlyCost({ ...result.item, kind: result.item.category.kind });
  const allocations = body.allocations.map((value) => {
    const item = value as Record<string, unknown>;
    const rawRate = item.plannedHourlyCost;
    return {
      projectMemberId: String(item.projectMemberId ?? "").trim(),
      plannedHours: Number(item.plannedHours ?? 0),
      plannedHourlyCost: rawRate === undefined || rawRate === null || rawRate === ""
        ? defaultHourlyCost
        : Number(rawRate),
      remark: String(item.remark ?? "").trim().slice(0, 500),
    };
  });
  if (allocations.some((allocation) => (
    !allocation.projectMemberId
    || !Number.isFinite(allocation.plannedHours)
    || allocation.plannedHours < 0
    || !Number.isFinite(allocation.plannedHourlyCost)
    || allocation.plannedHourlyCost < 0
  ))) return err("人员、计划工时和小时成本必须为合法的非负数");
  if (new Set(allocations.map((allocation) => allocation.projectMemberId)).size !== allocations.length) {
    return err("同一预算条目不能重复分配给同一项目成员");
  }
  const memberIds = allocations.map((allocation) => allocation.projectMemberId);
  const validMembers = memberIds.length === 0 ? [] : await prisma.projectMember.findMany({
    where: { projectId: id, id: { in: memberIds } },
    select: { id: true },
  });
  if (validMembers.length !== memberIds.length) return err("预算人员必须来自当前项目组成员");

  await prisma.$transaction(async (tx) => {
    await tx.projectBudgetLaborAllocation.deleteMany({ where: { projectId: id, budgetItemId: itemId } });
    if (allocations.length > 0) {
      await tx.projectBudgetLaborAllocation.createMany({
        data: allocations.map((allocation) => ({
          projectId: id,
          budgetItemId: itemId,
          ...allocation,
        })),
      });
    }
    await tx.operationHistory.create({
      data: {
        projectId: id,
        entityType: "PROJECT_BUDGET_LABOR_ALLOCATION",
        entityId: itemId,
        actionType: "UPDATE",
        operator: user.displayName,
        detail: `更新人力预算「${result.item.title || result.item.person || result.item.groupName || result.item.category.name}」的 ${allocations.length} 条人员分摊`,
      },
    });
  });

  const saved = await prisma.projectBudgetLaborAllocation.findMany({
    where: { projectId: id, budgetItemId: itemId },
    include: { projectMember: { select: { id: true, personName: true, roleName: true } } },
    orderBy: [{ projectMember: { personName: "asc" } }, { createdAt: "asc" }],
  });
  return ok({ allocations: saved.map(serializeAllocation) });
}
