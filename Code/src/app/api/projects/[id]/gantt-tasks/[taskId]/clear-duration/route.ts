import { NextRequest } from "next/server";

import { ensureMutableProject, err, ok } from "@/lib/api-utils";
import { getGanttPlanMutationBlockReasonForActor } from "@/lib/gantt-baseline-service";
import { clearProjectGanttTaskDurations } from "@/lib/gantt-task-service";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const user = await getAuthenticatedUser(req);
  if (!user) return err("未登录", 401);
  if (!await userHasPermission(user, "project-gantt:edit")) return err("权限不足", 403);

  const { id, taskId } = await params;
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;
  const baselineLockReason = await getGanttPlanMutationBlockReasonForActor({
    projectId: id,
    userId: user.userId,
    isAdministrator: user.assignedRoleNames.includes("管理员"),
  });
  if (baselineLockReason) return err(baselineLockReason, 409, "GANTT_BASELINE_LOCKED");

  try {
    return ok(await clearProjectGanttTaskDurations({
      projectId: id,
      taskId,
      operator: user.displayName,
    }));
  } catch (error) {
    return err(error instanceof Error ? error.message : "清除任务工期失败");
  }
}
