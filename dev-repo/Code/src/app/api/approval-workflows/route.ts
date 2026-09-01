import { NextRequest } from "next/server";

import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { normalizeApprovalWorkflowNodes, type ApprovalWorkflowDraftInput } from "@/lib/approval-workflow";
import { ensureDefaultApprovalWorkflows, saveApprovalWorkflowDraft } from "@/lib/approval-workflow-server";
import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "approval-workflow-config:view")) return forbidden();
  try {
    await ensureDefaultApprovalWorkflows(user);
    const definitions = await prisma.approvalWorkflowDefinition.findMany({
      orderBy: [{ moduleKey: "asc" }, { name: "asc" }],
      include: {
        versions: {
          orderBy: { version: "desc" },
          include: { nodes: { orderBy: { nodeOrder: "asc" } } },
        },
      },
    });
    return ok(definitions);
  } catch (error) {
    return err(error instanceof Error ? error.message : "审批流程配置加载失败", 500);
  }
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (
    !user.assignedRoleNames.includes(ADMIN_ROLE_NAME)
    || !await userHasPermission(user, "approval-workflow-config:edit")
  ) return forbidden();
  try {
    const body = await req.json() as Partial<ApprovalWorkflowDraftInput>;
    const draft: ApprovalWorkflowDraftInput = {
      businessType: String(body.businessType || "").trim(),
      moduleKey: String(body.moduleKey || "").trim(),
      name: String(body.name || "").trim(),
      description: String(body.description || "").trim(),
      enabled: body.enabled !== false,
      triggerPermissionKey: String(body.triggerPermissionKey || "").trim(),
      completionHandlerKey: String(body.completionHandlerKey || "").trim(),
      config: body.config && typeof body.config === "object" ? body.config : {},
      nodes: normalizeApprovalWorkflowNodes(body.nodes),
    };
    const version = await saveApprovalWorkflowDraft(draft, user);
    return ok(version, 201);
  } catch (error) {
    return err(error instanceof Error ? error.message : "审批流程草稿保存失败");
  }
}
