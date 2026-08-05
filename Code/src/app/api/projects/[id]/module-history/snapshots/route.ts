import { NextRequest } from "next/server";

import { ensureMutableProject, err, ok } from "@/lib/api-utils";
import { type ProjectModule } from "@/lib/module-history";
import { captureProjectModuleHistorySnapshot, requireProjectModule } from "@/lib/project-module-history";
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
    if (!canWrite.some(Boolean)) return err("权限不足", 403);
    const sessionId = String(body.sessionId ?? "").trim();
    const label = String(body.label ?? "模块操作").trim() || "模块操作";
    if (!sessionId) return err("操作历史会话不能为空");
    return ok(await captureProjectModuleHistorySnapshot({
      projectId: id,
      module: projectModule,
      sessionId,
      label,
      operator: user.displayName,
    }), 201);
  } catch (error) {
    return err(error instanceof Error ? error.message : "保存操作快照失败");
  }
}
