import { NextRequest } from "next/server";

import { err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

const readDelegation = (delegationId: string) => prisma.approvalDelegation.findUnique({ where: { id: delegationId } });

export async function PUT(req: NextRequest, { params }: { params: Promise<{ delegationId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "approval-workflow-config:delegate")) return forbidden();
  const { delegationId } = await params;
  const existing = await readDelegation(delegationId);
  if (!existing) return notFound("审批委托");
  try {
    const body = await req.json() as Record<string, unknown>;
    const startsAt = body.startsAt === undefined ? existing.startsAt : new Date(String(body.startsAt));
    const endsAt = body.endsAt === undefined ? existing.endsAt : new Date(String(body.endsAt));
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return err("委托时间格式不正确");
    if (endsAt <= startsAt) return err("结束时间必须晚于开始时间");
    const updated = await prisma.$transaction(async (tx) => {
      const delegation = await tx.approvalDelegation.update({
        where: { id: delegationId },
        data: {
          startsAt,
          endsAt,
          enabled: body.enabled === undefined ? existing.enabled : Boolean(body.enabled),
          reason: body.reason === undefined ? existing.reason : String(body.reason || "").trim(),
        },
      });
      await tx.adminAuditLog.create({
        data: {
          actionType: "APPROVAL_DELEGATION_UPDATED",
          operator: user.displayName,
          projectId: existing.projectId || "",
          detail: `更新审批委托：${existing.fromDisplayName} → ${existing.toDisplayName}`,
          snapshot: JSON.stringify({ delegationId, startsAt, endsAt, enabled: delegation.enabled }),
        },
      });
      return delegation;
    });
    return ok(updated);
  } catch (error) {
    return err(error instanceof Error ? error.message : "审批委托更新失败");
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ delegationId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "approval-workflow-config:delegate")) return forbidden();
  const { delegationId } = await params;
  const existing = await readDelegation(delegationId);
  if (!existing) return notFound("审批委托");
  await prisma.$transaction([
    prisma.approvalDelegation.delete({ where: { id: delegationId } }),
    prisma.adminAuditLog.create({
      data: {
        actionType: "APPROVAL_DELEGATION_DELETED",
        operator: user.displayName,
        projectId: existing.projectId || "",
        detail: `删除审批委托：${existing.fromDisplayName} → ${existing.toDisplayName}`,
        snapshot: JSON.stringify({ delegationId }),
      },
    }),
  ]);
  return ok({ deleted: true });
}
