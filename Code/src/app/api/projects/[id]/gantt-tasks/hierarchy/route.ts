import { NextRequest } from "next/server";

import { ensureMutableProject, err, ok } from "@/lib/api-utils";
import { getGanttPlanMutationBlockReasonForActor } from "@/lib/gantt-baseline-service";
import type { GanttHierarchyDirection } from "@/lib/gantt-hierarchy";
import { changeProjectGanttTaskHierarchy } from "@/lib/gantt-task-service";
import { requireUser, userHasPermission } from "@/lib/server-auth";

const DIRECTIONS = new Set<GanttHierarchyDirection>(["INDENT", "OUTDENT"]);

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser(req);
  if ("status" in user) return user;
  if (!(await userHasPermission(user, "project-gantt:edit"))) return err("权限不足", 403);

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
  const direction = String(body.direction || "") as GanttHierarchyDirection;
  const taskIds = Array.isArray(body.taskIds)
    ? Array.from(new Set(body.taskIds.map((value) => String(value || "").trim()).filter(Boolean)))
    : [];
  if (!DIRECTIONS.has(direction)) return err("层级调整方向无效");
  if (taskIds.length === 0) return err("请选择需要调整层级的任务");

  let changed;
  try {
    changed = await changeProjectGanttTaskHierarchy({
      projectId: id,
      taskIds,
      direction,
      operator: user.displayName,
    });
  } catch (error) {
    return err(error instanceof Error ? error.message : "任务层级调整失败", 404);
  }
  return ok({
    tasks: changed.tasks,
    movedTaskIds: changed.movedTaskIds,
    message: changed.movedTaskIds.length > 0
      ? `已${direction === "INDENT" ? "下移" : "上移"} ${changed.movedTaskIds.length} 个任务层级`
      : "所选任务已位于当前方向的边界，未发生变化",
  });
}
