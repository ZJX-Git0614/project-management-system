import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";

import { requireSuperAdmin } from "@/lib/admin-auth";
import { err, ok } from "@/lib/api-utils";
import {
  createSystemBackup,
  DEFAULT_SYSTEM_BACKUP_ROOT,
  restoreDatabaseDump,
  validateDatabaseDump,
} from "@/lib/system-backup";
import { prisma } from "@/lib/prisma";
import { signToken } from "@/lib/auth";
import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { parseRoleNames } from "@/lib/role-assignments";
import { recordSystemEvent } from "@/lib/system-event-log";

const MAX_RESTORE_BYTES = 512 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("response" in auth) return auth.response;
  const formData = await req.formData();
  const file = formData.get("file");
  const confirmText = String(formData.get("confirmText") ?? "");
  if (confirmText !== "恢复数据库") return err("请确认恢复数据库操作");
  if (!(file instanceof File)) return err("请选择 PostgreSQL .dump 备份文件");
  if (!file.name.toLowerCase().endsWith(".dump")) return err("仅支持系统导出的 .dump 数据库备份文件");
  if (file.size <= 0 || file.size > MAX_RESTORE_BYTES) return err("数据库备份文件为空或超过 512 MB");

  const uploadDirectory = path.join(DEFAULT_SYSTEM_BACKUP_ROOT, ".restore-uploads");
  const dumpPath = path.join(uploadDirectory, `restore-${Date.now()}.dump`);
  try {
    await mkdir(uploadDirectory, { recursive: true });
    await writeFile(dumpPath, Buffer.from(await file.arrayBuffer()));
    await validateDatabaseDump(dumpPath);
    await createSystemBackup({ triggerMode: "MANUAL", operator: `${auth.user.displayName}（恢复前自动备份）` });
    await restoreDatabaseDump(dumpPath);
    const restoredAccount = await prisma.userAccount.findUnique({
      where: { id: auth.user.userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        enabled: true,
        assignedRoleNames: true,
        passwordResetRequired: true,
      },
    });
    const restoredRoleNames = parseRoleNames(restoredAccount?.assignedRoleNames);
    const sessionPreserved = Boolean(restoredAccount?.enabled && restoredRoleNames.includes(ADMIN_ROLE_NAME));
    await prisma.adminAuditLog.create({
      data: {
        actionType: "RESTORE_DATABASE",
        operator: auth.user.displayName,
        detail: `从文件“${file.name}”恢复系统数据库，恢复前已自动创建完整备份`,
        snapshot: JSON.stringify({ fileName: file.name, sizeBytes: file.size }),
      },
    }).catch(() => undefined);
    await recordSystemEvent({
      level: "SECURITY",
      category: "ADMIN",
      module: "system-data",
      eventType: "RESTORE_DATABASE",
      operatorId: auth.user.userId,
      operatorName: auth.user.displayName,
      message: "系统数据库完整恢复完成",
      details: { fileName: file.name, sizeBytes: file.size, sessionPreserved },
    });
    return ok({
      message: sessionPreserved ? "数据库恢复完成，当前管理员会话已延续" : "数据库恢复完成，当前账号状态或管理员权限已变化，请重新登录",
      sessionPreserved,
      ...(sessionPreserved && restoredAccount ? {
        token: signToken({ userId: restoredAccount.id, username: restoredAccount.username, displayName: restoredAccount.displayName }),
        user: {
          id: restoredAccount.id,
          username: restoredAccount.username,
          displayName: restoredAccount.displayName,
          assignedRoleNames: restoredRoleNames,
          passwordResetRequired: restoredAccount.passwordResetRequired,
        },
      } : {}),
    });
  } catch (error) {
    return err(error instanceof Error ? error.message : "数据库恢复失败", 500);
  } finally {
    await rm(dumpPath, { force: true }).catch(() => undefined);
  }
}
