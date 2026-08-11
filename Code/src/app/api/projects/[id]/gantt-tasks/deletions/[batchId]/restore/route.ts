import { NextRequest } from "next/server";

import { ensureMutableProject, err, ok } from "@/lib/api-utils";
import { getGanttPlanMutationBlockReasonForActor } from "@/lib/gantt-baseline-service";
import { GanttRevisionConflictError, restoreGanttTaskDeletionBatch } from "@/lib/gantt-task-service";
import { requireUser, userHasPermission } from "@/lib/server-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; batchId: string }> },
) {
  const user = await requireUser(req);
  if ("status" in user) return user;
  if (!(await userHasPermission(user, "project-gantt:delete"))) return err("权限不足", 403);

  const { id, batchId } = await params;
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;
  const baselineLockReason = await getGanttPlanMutationBlockReasonForActor({
    projectId: id,
    userId: user.userId,
    isAdministrator: user.assignedRoleNames.includes("管理员"),
  });
  if (baselineLockReason) return err(baselineLockReason, 409, "GANTT_BASELINE_LOCKED");

  try {
    const result = await restoreGanttTaskDeletionBatch({
      projectId: id,
      batchId,
      operator: user.displayName,
      operatorUserId: user.userId,
    });
    return ok(result);
  } catch (error) {
    if (error instanceof GanttRevisionConflictError) {
      return err(error.message, 409, error.code);
    }
    return err(error instanceof Error ? error.message : "恢复失败");
  }
}
