import { NextRequest } from "next/server";

import { ensureMutableProject, err, ok } from "@/lib/api-utils";
import { getGanttPlanMutationBlockReasonForActor } from "@/lib/gantt-baseline-service";
import {
  copyProjectGanttTasks,
  insertProjectGanttTasks,
  moveProjectGanttTaskBranches,
  type GanttInsertPlacement,
  type GanttPastePosition,
} from "@/lib/gantt-task-service";
import { requireUser, userHasPermission } from "@/lib/server-auth";

const INSERT_PLACEMENTS = new Set<GanttInsertPlacement>(["SIBLING_BEFORE", "SIBLING_AFTER", "CHILD_FIRST", "CHILD_LAST"]);
const PASTE_POSITIONS = new Set<GanttPastePosition>(["BEFORE", "AFTER"]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser(req);
  if ("status" in user) return user;
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
  const operation = String(body.operation ?? "").toUpperCase();

  try {
    if (operation === "INSERT") {
      if (!(await userHasPermission(user, "project-gantt:create"))) return err("权限不足", 403);
      const placement = String(body.placement ?? "") as GanttInsertPlacement;
      const count = Number(body.count ?? 1);
      if (!INSERT_PLACEMENTS.has(placement)) return err("任务插入位置无效");
      if (!Number.isInteger(count) || count < 1 || count > 100) return err("插入数量必须是 1-100 的整数");
      return ok(await insertProjectGanttTasks({
        projectId: id,
        anchorTaskId: String(body.anchorTaskId ?? ""),
        placement,
        count,
        operator: user.displayName,
      }), 201);
    }

    if (operation === "COPY" || operation === "MOVE") {
      const requiredPermission = operation === "COPY" ? "project-gantt:create" : "project-gantt:edit";
      if (!(await userHasPermission(user, requiredPermission))) return err("权限不足", 403);
      const position = String(body.position ?? "") as GanttPastePosition;
      if (!PASTE_POSITIONS.has(position)) return err("任务粘贴位置无效");
      const sourceTaskIds = Array.isArray(body.sourceTaskIds) ? body.sourceTaskIds.map((value) => String(value)) : [];
      const common = {
        projectId: id,
        sourceTaskIds,
        anchorTaskId: String(body.anchorTaskId ?? ""),
        position,
        operator: user.displayName,
      };
      return ok(operation === "COPY"
        ? await copyProjectGanttTasks(common)
        : await moveProjectGanttTaskBranches(common), operation === "COPY" ? 201 : 200);
    }
    return err("不支持的任务结构操作");
  } catch (error) {
    return err(error instanceof Error ? error.message : "任务结构操作失败");
  }
}
