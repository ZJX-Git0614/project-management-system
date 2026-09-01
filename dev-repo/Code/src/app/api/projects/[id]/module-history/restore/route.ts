import { NextRequest } from "next/server";

import { ensureMutableProject, err, ok } from "@/lib/api-utils";
import { type ProjectModule } from "@/lib/module-history";
import { requireProjectModule, restoreProjectModuleHistorySnapshot } from "@/lib/project-module-history";
import { requireUser, userHasPermission } from "@/lib/server-auth";

const MODULE_PERMISSIONS: Record<ProjectModule, string[]> = {
  WEEKLY_ITEMS: ["weekly-items:create", "weekly-items:edit", "weekly-items:delete"],
  RISK_REGISTER: ["risk-register:create", "risk-register:edit", "risk-register:delete"],
  PROJECT_BUDGET: ["project-budget:create", "project-budget:edit", "project-budget:delete", "project-budget:category-manage"],
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser(req);
  if ("status" in user) return user;
  const { id } = await params;
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  try {
    const projectModule = requireProjectModule(body.module);
    const canWrite = await Promise.all(MODULE_PERMISSIONS[projectModule].map((permission) => (
      userHasPermission(user, permission)
    )));
    if (!canWrite.every(Boolean)) return err("恢复整个模块需要该模块全部增删改权限", 403);
    const snapshotId = String(body.snapshotId ?? "").trim();
    const actionLabel = String(body.actionLabel ?? "恢复模块操作").trim() || "恢复模块操作";
    if (!snapshotId) return err("撤销快照不能为空");
    return ok(await restoreProjectModuleHistorySnapshot({
      projectId: id,
      module: projectModule,
      snapshotId,
      operator: user.displayName,
      actionLabel,
    }));
  } catch (error) {
    return err(error instanceof Error ? error.message : "恢复操作快照失败");
  }
}
