import { NextRequest } from "next/server";

import { requireSuperAdmin } from "@/lib/admin-auth";
import { err, ok } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { rollbackProjectRestore } from "@/lib/project-restore";
import { recordSystemEvent } from "@/lib/system-event-log";

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("response" in auth) return auth.response;
  const body = await req.json() as { batchId?: string; confirmText?: string };
  if (body.confirmText !== "回滚项目恢复") return err("请确认回滚项目恢复操作");
  const batch = await prisma.projectRestoreBatch.findUnique({ where: { id: String(body.batchId ?? "") } });
  if (!batch) return err("项目恢复批次不存在", 404);
  if (batch.status !== "COMPLETED") return err("该恢复批次当前不可回滚", 409);
  if (batch.expiresAt.getTime() < Date.now() || !batch.protectionSnapshotDir) return err("30 天保护期已结束，不能回滚", 410);
  try {
    const snapshots = await rollbackProjectRestore({ protectionSnapshotDir: batch.protectionSnapshotDir, operatorName: auth.user.displayName });
    await prisma.projectRestoreBatch.update({ where: { id: batch.id }, data: { status: "ROLLED_BACK", rolledBackAt: new Date() } });
    await prisma.adminAuditLog.create({ data: { actionType: "ROLLBACK_PROJECT_RESTORE", operator: auth.user.displayName, detail: `回滚项目恢复批次 ${batch.id}`, snapshot: JSON.stringify({ batchId: batch.id, projectIds: snapshots.map((snapshot) => snapshot.projectId) }) } });
    await recordSystemEvent({ level: "SECURITY", category: "ADMIN", module: "system-data", eventType: "ROLLBACK_PROJECT_RESTORE", operatorId: auth.user.userId, operatorName: auth.user.displayName, message: `已回滚项目恢复批次 ${batch.id}` });
    return ok({ message: "已恢复到项目导入前状态", projectCount: snapshots.length });
  } catch (error) {
    return err(error instanceof Error ? error.message : "项目恢复回滚失败", 500);
  }
}
