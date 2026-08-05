import { NextRequest } from "next/server";

import { ensureMutableProject, err, ok } from "@/lib/api-utils";
import { restoreProjectGanttHistorySnapshot } from "@/lib/gantt-task-service";
import { requireUser, userHasPermission } from "@/lib/server-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser(req);
  if ("status" in user) return user;
  const canWrite = await Promise.all([
    userHasPermission(user, "project-gantt:create"),
    userHasPermission(user, "project-gantt:edit"),
    userHasPermission(user, "project-gantt:delete"),
  ]);
  if (!canWrite.every(Boolean)) return err("恢复整个 WBS 需要新增、编辑和删除权限", 403);

  const { id } = await params;
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const snapshotId = String(body.snapshotId ?? "").trim();
  const actionLabel = String(body.actionLabel ?? "恢复甘特任务操作").trim() || "恢复甘特任务操作";
  if (!snapshotId) return err("撤销快照不能为空");

  try {
    return ok(await restoreProjectGanttHistorySnapshot({
      projectId: id,
      snapshotId,
      operator: user.displayName,
      actionLabel,
    }));
  } catch (error) {
    return err(error instanceof Error ? error.message : "恢复操作快照失败");
  }
}
