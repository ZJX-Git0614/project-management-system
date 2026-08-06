import { NextRequest } from "next/server";

import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { submitApprovalNodeAction } from "@/lib/approval-workflow-server";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ instanceId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "approval-center:process")) return forbidden();
  try {
    const { instanceId } = await params;
    const body = await req.json() as Record<string, unknown>;
    return ok(await submitApprovalNodeAction({
      instanceId,
      nodeInstanceId: String(body.nodeInstanceId || ""),
      actionKey: String(body.actionKey || ""),
      actionType: String(body.actionType || "FORM"),
      actionName: String(body.actionName || "节点动作"),
      data: body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data as Record<string, unknown> : {},
      operator: user,
    }));
  } catch (error) {
    return err(error instanceof Error ? error.message : "节点动作提交失败");
  }
}
