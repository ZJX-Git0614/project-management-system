import { NextRequest } from "next/server";

import { ensureMutableProject, err, ok } from "@/lib/api-utils";
import { listGanttTaskDeletionBatches } from "@/lib/gantt-task-service";
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
