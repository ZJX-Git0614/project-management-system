import { NextRequest } from "next/server";

import { requireSuperAdmin } from "@/lib/admin-auth";
import { err, ok } from "@/lib/api-utils";
import {
  applyProjectSnapshots,
  createProjectProtectionSnapshot,
  PROJECT_RESTORE_PROTECTION_DAYS,
  readRestoreSession,
  restoreProjectDocuments,
  rollbackProjectRestore,
  type ProjectAccountResolution,
} from "@/lib/project-restore";
import { prisma } from "@/lib/prisma";
import { recordSystemEvent } from "@/lib/system-event-log";

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("response" in auth) return auth.response;
  const body = await req.json() as {
    sessionId?: string;
    projectIds?: string[];
    resolutions?: ProjectAccountResolution[];
    confirmText?: string;
  };
  if (body.confirmText !== "恢复所选项目") return err("请确认恢复所选项目操作");
  const session = await readRestoreSession(String(body.sessionId ?? "")).catch(() => null);
  if (!session) return err("恢复预检不存在或已过期，请重新选择备份文件", 410);
  const projectIds = Array.from(new Set((body.projectIds ?? []).filter((id) => session.snapshots.some((snapshot) => snapshot.projectId === id))));
  if (projectIds.length === 0) return err("请至少选择一个项目");
  const selectedSnapshots = session.snapshots.filter((snapshot) => projectIds.includes(snapshot.projectId));
  const selectedMissingDocuments = session.documentCheck.missingFiles.filter((file) => projectIds.some((projectId) => file.startsWith(`${projectId}/`)));
  if (selectedMissingDocuments.length > 0) return err(`文档备份不完整，缺少 ${selectedMissingDocuments.length} 个文件，不能执行恢复`);
  const selectedSourceAccountIds = new Set(selectedSnapshots.flatMap((snapshot) => (
    snapshot.tables.find((table) => table.table === "ProjectMember")?.rows.map((row) => String(row.accountId ?? "")).filter(Boolean) ?? []
  )));
  const sourceAccounts = session.sourceAccounts.filter((account) => selectedSourceAccountIds.has(account.id));
  const expiresAt = new Date(Date.now() + PROJECT_RESTORE_PROTECTION_DAYS * 24 * 60 * 60 * 1000);
  const batch = await prisma.projectRestoreBatch.create({
    data: {
      expiresAt,
      status: "PREPARING",
      operatorId: auth.user.userId,
      operatorName: auth.user.displayName,
      sourceFileName: session.sourceFileName,
      projectIds: JSON.stringify(projectIds),
      projectNames: JSON.stringify(selectedSnapshots.map((snapshot) => snapshot.projectName)),
    },
  });
  let protectionSnapshotDir = "";
  try {
    protectionSnapshotDir = await createProjectProtectionSnapshot(batch.id, projectIds);
    await prisma.projectRestoreBatch.update({ where: { id: batch.id }, data: { status: "RESTORING", protectionSnapshotDir } });
    const result = await applyProjectSnapshots({
      snapshots: selectedSnapshots,
      resolutions: body.resolutions ?? [],
      sourceAccounts,
      operatorName: auth.user.displayName,
    });
    await restoreProjectDocuments(session, projectIds);
    const completed = await prisma.projectRestoreBatch.update({
      where: { id: batch.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        summary: JSON.stringify({
          projectCount: selectedSnapshots.length,
          historicalAccounts: result.historicalAccounts.map((item) => ({ id: item.source.id, username: item.username, displayName: item.source.displayName })),
        }),
      },
    });
    await prisma.adminAuditLog.create({
      data: {
        actionType: "RESTORE_PROJECTS",
        operator: auth.user.displayName,
        detail: `恢复 ${selectedSnapshots.length} 个完整项目，已创建 30 天保护快照`,
        snapshot: JSON.stringify({ batchId: batch.id, projectIds, expiresAt, historicalAccounts: result.historicalAccounts }),
      },
    });
    await recordSystemEvent({ level: "SECURITY", category: "ADMIN", module: "system-data", eventType: "RESTORE_PROJECTS", operatorId: auth.user.userId, operatorName: auth.user.displayName, message: `完整恢复 ${selectedSnapshots.length} 个项目`, details: { batchId: batch.id, projectIds } });
    return ok({
      batchId: completed.id,
      expiresAt: completed.expiresAt.toISOString(),
      projectCount: selectedSnapshots.length,
      historicalAccounts: result.historicalAccounts.map((item) => ({ id: item.source.id, username: item.username, displayName: item.source.displayName, enabled: false })),
      message: result.historicalAccounts.length > 0
        ? `项目恢复完成；另恢复 ${result.historicalAccounts.length} 个曾用账号，均已停用。请管理员设置新密码和当前角色后再启用。`
        : "项目恢复完成，30 天内可回滚到恢复前状态。",
    });
  } catch (error) {
    if (protectionSnapshotDir) {
      await rollbackProjectRestore({ protectionSnapshotDir, operatorName: `${auth.user.displayName}（恢复失败自动回滚）` }).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : "项目恢复失败";
    await prisma.projectRestoreBatch.update({ where: { id: batch.id }, data: { status: "FAILED", errorMessage: message, protectionSnapshotDir } }).catch(() => undefined);
    await recordSystemEvent({ level: "ERROR", category: "ERROR", module: "system-data", eventType: "RESTORE_PROJECTS_FAILED", operatorId: auth.user.userId, operatorName: auth.user.displayName, message, details: { batchId: batch.id, projectIds } });
    return err(`${message}；系统已尝试恢复到执行前状态`, 500);
  }
}
