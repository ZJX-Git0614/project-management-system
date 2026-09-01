import { NextRequest } from "next/server";

import { ensureMutableProject, err, ok } from "@/lib/api-utils";
import { getGanttPlanMutationBlockReasonForActor } from "@/lib/gantt-baseline-service";
import { deleteGanttTaskSubtrees, GanttRevisionConflictError, listGanttTaskDeletionBatches } from "@/lib/gantt-task-service";
import { requireUser, userHasPermission } from "@/lib/server-auth";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser(req);
  if ("status" in user) return user;
  if (!(await userHasPermission(user, "project-gantt:delete"))) return err("权限不足", 403);

  const { id } = await params;
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const batches = await listGanttTaskDeletionBatches(id);
  return ok(batches);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser(req);
  if ("status" in user) return user;
  if (!(await userHasPermission(user, "project-gantt:delete"))) return err("权限不足", 403);

  const { id } = await params;
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;
  const baselineLockReason = await getGanttPlanMutationBlockReasonForActor({
    projectId: id,
    userId: user.userId,
    isAdministrator: user.assignedRoleNames.includes("管理员"),
  });
  if (baselineLockReason) return err(baselineLockReason, 409, "GANTT_BASELINE_LOCKED");
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const rootTaskIds = Array.isArray(body.rootTaskIds)
    ? Array.from(new Set(body.rootTaskIds.map((value) => String(value || "").trim()).filter(Boolean)))
    : [];
  if (rootTaskIds.length === 0) return err("请选择需要删除的甘特任务");

  try {
    return ok(await deleteGanttTaskSubtrees({
      projectId: id,
      rootTaskIds,
      operator: user.displayName,
      operatorUserId: user.userId,
    }));
  } catch (error) {
    if (error instanceof GanttRevisionConflictError) return err(error.message, 409, error.code);
    return err(error instanceof Error ? error.message : "删除失败");
  }
}
