import { NextRequest } from "next/server";

import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { cancelApprovalWorkflow, INSTANCE_INCLUDE, serializeApprovalInstance } from "@/lib/approval-workflow-server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function GET(req: NextRequest, { params }: { params: Promise<{ instanceId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "approval-center:view")) return forbidden();
  const { instanceId } = await params;
  const instance = await prisma.approvalWorkflowInstance.findUnique({ where: { id: instanceId }, include: INSTANCE_INCLUDE });
  if (!instance) return notFound("审批实例");
  const related = user.assignedRoleNames.includes(ADMIN_ROLE_NAME)
    || instance.requesterAccountId === user.userId
    || instance.nodes.some((node) => node.assignments.some((assignment) => assignment.accountId === user.userId));
  if (!related) return forbidden();
  return ok(serializeApprovalInstance(instance));
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ instanceId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "approval-center:cancel")) return forbidden();
  try {
    const { instanceId } = await params;
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const allowAny = user.assignedRoleNames.includes(ADMIN_ROLE_NAME);
    return ok(serializeApprovalInstance(await cancelApprovalWorkflow({ instanceId, operator: user, reason: String(body.reason || ""), allowAny })));
  } catch (error) {
    return err(error instanceof Error ? error.message : "审批撤销失败");
  }
}
