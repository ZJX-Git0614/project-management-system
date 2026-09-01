import { NextRequest } from "next/server";

import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { processApprovalAction, serializeApprovalInstance } from "@/lib/approval-workflow-server";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ instanceId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "approval-center:process")) return forbidden();
  try {
    const { instanceId } = await params;
    const body = await req.json() as Record<string, unknown>;
    const action = String(body.action || "") as "approve" | "reject" | "return";
    if (!(["approve", "reject", "return"] as string[]).includes(action)) return err("审批动作无效");
    const instance = await processApprovalAction({ instanceId, action, comment: String(body.comment || ""), operator: user });
    return ok(serializeApprovalInstance(instance));
  } catch (error) {
    return err(error instanceof Error ? error.message : "审批处理失败");
  }
}
