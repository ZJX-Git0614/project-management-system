import { NextRequest } from "next/server";

import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import {
  APPROVAL_BUSINESS_TYPES,
  approvalBusinessIdForWbsTaskProgressSubmission,
} from "@/lib/approval-workflow";
import { serializeApprovalInstance, startApprovalWorkflow } from "@/lib/approval-workflow-server";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:view")) return forbidden();

  const { id, taskId } = await params;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  try {
    const approval = await startApprovalWorkflow({
      projectId: id,
      businessType: APPROVAL_BUSINESS_TYPES.WBS_TASK_PROGRESS_SUBMISSION,
      businessId: approvalBusinessIdForWbsTaskProgressSubmission(id, taskId),
      requester: user,
      payload: {
        taskId,
        taskCode: String(body.taskCode ?? "").trim(),
        taskName: String(body.taskName ?? "").trim(),
        progress: body.progress,
        actualStartDate: String(body.actualStartDate ?? "").trim(),
        actualEndDate: String(body.actualEndDate ?? "").trim(),
        actualWorkHours: body.actualWorkHours,
      },
    });
    return ok({ approvalRequired: true, approvalInstance: serializeApprovalInstance(approval) }, 202);
  } catch (error) {
    return err(error instanceof Error ? error.message : "WBS 任务进度审批发起失败");
  }
}
