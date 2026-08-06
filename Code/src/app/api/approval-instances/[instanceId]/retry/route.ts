import { NextRequest } from "next/server";

import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { retryApprovalEffect, serializeApprovalInstance } from "@/lib/approval-workflow-server";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ instanceId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "approval-center:retry")) return forbidden();
  try {
    const { instanceId } = await params;
    return ok(serializeApprovalInstance(await retryApprovalEffect(instanceId)));
  } catch (error) {
    return err(error instanceof Error ? error.message : "审批业务执行重试失败");
  }
}
