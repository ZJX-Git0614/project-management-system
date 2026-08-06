import { NextRequest } from "next/server";

import { forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "approval-workflow-config:analytics")) return forbidden();
  const projectId = req.nextUrl.searchParams.get("projectId") || undefined;
  const instanceWhere = projectId ? { projectId } : {};
  const now = new Date();
  const [statusGroups, businessGroups, completed, overdue, pendingNodes, delegations, recent] = await Promise.all([
    prisma.approvalWorkflowInstance.groupBy({ by: ["status"], where: instanceWhere, _count: { _all: true } }),
    prisma.approvalWorkflowInstance.groupBy({ by: ["businessType", "status"], where: instanceWhere, _count: { _all: true } }),
    prisma.approvalWorkflowInstance.findMany({
      where: { ...instanceWhere, completedAt: { not: null } },
      select: { requestedAt: true, completedAt: true },
      orderBy: { completedAt: "desc" },
      take: 1000,
    }),
    prisma.todoItem.count({ where: { ...(projectId ? { projectId } : {}), type: "APPROVAL_PENDING", status: "OPEN", dueAt: { lt: now } } }),
    prisma.approvalNodeInstance.groupBy({ by: ["nodeName"], where: { status: "PENDING", ...(projectId ? { instance: { projectId } } : {}) }, _count: { _all: true } }),
    prisma.approvalDelegation.count({ where: { enabled: true, startsAt: { lte: now }, endsAt: { gte: now }, ...(projectId ? { OR: [{ projectId }, { projectId: null }] } : {}) } }),
    prisma.approvalWorkflowInstance.findMany({
      where: instanceWhere,
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, title: true, status: true, businessType: true, requesterName: true, requestedAt: true, completedAt: true, project: { select: { code: true, name: true } } },
    }),
  ]);
  const cycleHours = completed.flatMap((item) => item.completedAt
    ? [(item.completedAt.getTime() - item.requestedAt.getTime()) / 3_600_000]
    : []);
  return ok({
    total: statusGroups.reduce((sum, item) => sum + item._count._all, 0),
    statusCounts: Object.fromEntries(statusGroups.map((item) => [item.status, item._count._all])),
    businessCounts: businessGroups.reduce<Record<string, Record<string, number>>>((result, item) => {
      result[item.businessType] ||= {};
      result[item.businessType][item.status] = item._count._all;
      return result;
    }, {}),
    averageCycleHours: cycleHours.length > 0 ? cycleHours.reduce((sum, value) => sum + value, 0) / cycleHours.length : 0,
    overdue,
    activeDelegations: delegations,
    pendingNodes: pendingNodes.sort((left, right) => right._count._all - left._count._all).map((item) => ({ nodeName: item.nodeName, count: item._count._all })),
    recent: recent.map((item) => ({ ...item, requestedAt: item.requestedAt.toISOString(), completedAt: item.completedAt?.toISOString() ?? null })),
  });
}
