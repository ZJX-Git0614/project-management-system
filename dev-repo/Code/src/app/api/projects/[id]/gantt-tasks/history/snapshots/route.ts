import { NextRequest } from "next/server";

import { ensureMutableProject, err, ok } from "@/lib/api-utils";
import { captureProjectGanttHistorySnapshot } from "@/lib/gantt-task-service";
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
  if (!canWrite.some(Boolean)) return err("权限不足", 403);

  const { id } = await params;
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const sessionId = String(body.sessionId ?? "").trim();
  const label = String(body.label ?? "甘特任务操作").trim() || "甘特任务操作";
  if (!sessionId) return err("操作历史会话不能为空");

  try {
    return ok(await captureProjectGanttHistorySnapshot({
      projectId: id,
      sessionId,
      label,
      operator: user.displayName,
    }), 201);
  } catch (error) {
    return err(error instanceof Error ? error.message : "保存操作快照失败");
  }
}
