import { NextRequest } from "next/server";

import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

const parseDate = (value: unknown, fieldName: string) => {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) throw new Error(`${fieldName}格式不正确`);
  return date;
};

const validateAccounts = async (fromAccountId: string, toAccountId: string) => {
  if (!fromAccountId || !toAccountId) throw new Error("委托人和受托人不能为空");
  if (fromAccountId === toAccountId) throw new Error("委托人和受托人不能是同一账号");
  const accounts = await prisma.userAccount.findMany({
    where: { id: { in: [fromAccountId, toAccountId] }, enabled: true },
    select: { id: true, displayName: true },
  });
  const from = accounts.find((account) => account.id === fromAccountId);
  const to = accounts.find((account) => account.id === toAccountId);
  if (!from || !to) throw new Error("委托账号不存在或已停用");
  return { from, to };
};

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "approval-workflow-config:delegate")) return forbidden();
  const projectId = req.nextUrl.searchParams.get("projectId") || undefined;
  const delegations = await prisma.approvalDelegation.findMany({
    where: projectId ? { OR: [{ projectId }, { projectId: null }] } : undefined,
    orderBy: [{ enabled: "desc" }, { startsAt: "desc" }],
    take: 300,
  });
  return ok(delegations.map((item) => ({
    ...item,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    startsAt: item.startsAt.toISOString(),
    endsAt: item.endsAt.toISOString(),
  })));
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "approval-workflow-config:delegate")) return forbidden();
  try {
    const body = await req.json() as Record<string, unknown>;
    const fromAccountId = String(body.fromAccountId || "").trim();
    const toAccountId = String(body.toAccountId || "").trim();
    const projectId = String(body.projectId || "").trim() || null;
    const startsAt = parseDate(body.startsAt, "开始时间");
    const endsAt = parseDate(body.endsAt, "结束时间");
    if (endsAt <= startsAt) return err("结束时间必须晚于开始时间");
    const { from, to } = await validateAccounts(fromAccountId, toAccountId);
    if (projectId && !await prisma.project.count({ where: { id: projectId } })) return err("指定项目不存在");
    const overlap = await prisma.approvalDelegation.findFirst({
      where: {
        fromAccountId,
        enabled: true,
        OR: [{ projectId }, { projectId: null }, ...(projectId ? [] : [{ projectId: { not: null } }])],
        startsAt: { lte: endsAt },
        endsAt: { gte: startsAt },
      },
      select: { id: true },
    });
    if (overlap) return err("该委托人在所选时段已有生效范围重叠的委托");
    const created = await prisma.$transaction(async (tx) => {
      const delegation = await tx.approvalDelegation.create({
        data: {
          projectId,
          fromAccountId,
          fromDisplayName: from.displayName,
          toAccountId,
          toDisplayName: to.displayName,
          startsAt,
          endsAt,
          enabled: body.enabled !== false,
          reason: String(body.reason || "").trim(),
          createdByAccountId: user.userId,
          createdByName: user.displayName,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          actionType: "APPROVAL_DELEGATION_CREATED",
          operator: user.displayName,
          projectId: projectId || "",
          detail: `创建审批委托：${from.displayName} → ${to.displayName}`,
          snapshot: JSON.stringify({ delegationId: delegation.id, fromAccountId, toAccountId, startsAt, endsAt }),
        },
      });
      return delegation;
    });
    return ok(created, 201);
  } catch (error) {
    return err(error instanceof Error ? error.message : "审批委托创建失败");
  }
}
