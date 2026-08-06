import { NextRequest } from "next/server";

import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { publishApprovalWorkflowVersion } from "@/lib/approval-workflow-server";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "approval-workflow-config:publish")) return forbidden();
  try {
    const { versionId } = await params;
    return ok(await publishApprovalWorkflowVersion(versionId, user));
  } catch (error) {
    return err(error instanceof Error ? error.message : "审批流程发布失败");
  }
}
