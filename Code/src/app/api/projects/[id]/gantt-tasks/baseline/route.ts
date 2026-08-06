import { NextRequest } from "next/server";

import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { APPROVAL_BUSINESS_TYPES, approvalBusinessIdForWbsBaseline } from "@/lib/approval-workflow";
import { serializeApprovalInstance, startApprovalWorkflow } from "@/lib/approval-workflow-server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:baseline-request")) return forbidden();

  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true, ganttRevision: true, status: true },
  });
  if (!project) return err("项目不存在", 404);
  if (project.status === "COMPLETED" || project.status === "VOIDED") {
    return err("已完成或已作废的项目不能发布新的 WBS 基线", 403);
  }

  try {
    const approval = await startApprovalWorkflow({
      projectId: id,
      businessType: APPROVAL_BUSINESS_TYPES.WBS_BASELINE_PUBLISH,
      businessId: approvalBusinessIdForWbsBaseline(id),
      requester: user,
      payload: { ganttRevision: project.ganttRevision },
    });
    return ok({ approvalRequired: true, approvalInstance: serializeApprovalInstance(approval) }, 202);
  } catch (error) {
    return err(error instanceof Error ? error.message : "WBS 基线审批发起失败");
  }
}
