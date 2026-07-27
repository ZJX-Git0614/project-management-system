import { NextRequest } from "next/server";

import { requireSuperAdmin } from "@/lib/admin-auth";
import { err, ok } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { syncLatestSystemBackupToCloud } from "@/lib/system-backup";

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("response" in auth) return auth.response;
  try {
    const backup = await syncLatestSystemBackupToCloud({ operator: auth.user.displayName });
    await prisma.adminAuditLog.create({
      data: {
        actionType: "SYNC_SYSTEM_BACKUP_TO_CLOUD",
        operator: auth.user.displayName,
        detail: "手动将最新本地系统备份同步到公司云盘",
        snapshot: JSON.stringify({ backupId: backup.id, cloudStatus: backup.cloudStatus }),
      },
    });
    return ok({ backup, message: "最新本地备份已同步到公司云盘" });
  } catch (error) {
    return err(error instanceof Error ? error.message : "公司云盘备份失败", 500);
  }
}
