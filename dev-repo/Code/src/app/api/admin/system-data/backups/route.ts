import path from "node:path";
import { NextRequest } from "next/server";

import { requireSuperAdmin } from "@/lib/admin-auth";
import { encryptAssistantSecret } from "@/lib/assistant-secrets";
import { err, ok } from "@/lib/api-utils";
import {
  createSystemBackup,
  CLOUD_BACKUP_LIMIT_BYTES,
  DEFAULT_SYSTEM_BACKUP_ROOT,
  getSystemBackupSettings,
  getLocalBackupUsageBytes,
  LOCAL_BACKUP_LIMIT_BYTES,
  SYSTEM_BACKUP_INTERVAL_HOURS,
} from "@/lib/system-backup";
import { prisma } from "@/lib/prisma";

const serializeSettings = (settings: Awaited<ReturnType<typeof getSystemBackupSettings>>) => ({
  id: settings.id,
  automaticBackupEnabled: settings.automaticBackupEnabled,
  intervalHours: SYSTEM_BACKUP_INTERVAL_HOURS,
  localDirectory: settings.localDirectory || DEFAULT_SYSTEM_BACKUP_ROOT,
  localLimitBytes: LOCAL_BACKUP_LIMIT_BYTES,
  cloudLimitBytes: CLOUD_BACKUP_LIMIT_BYTES,
  cloudEnabled: settings.cloudEnabled,
  cloudProvider: settings.cloudProvider,
  cloudBaseUrl: settings.cloudBaseUrl,
  cloudUsername: settings.cloudUsername,
  cloudPasswordConfigured: Boolean(settings.cloudPasswordEncrypted),
  cloudDirectory: settings.cloudDirectory,
  lastAutomaticBackupAt: settings.lastAutomaticBackupAt?.toISOString() ?? null,
  nextAutomaticBackupAt: settings.automaticBackupEnabled
    ? new Date(settings.lastAutomaticBackupAt
      ? settings.lastAutomaticBackupAt.getTime() + SYSTEM_BACKUP_INTERVAL_HOURS * 60 * 60 * 1000
      : Date.now()).toISOString()
    : null,
  lastBackupStatus: settings.lastBackupStatus,
  lastBackupMessage: settings.lastBackupMessage,
});

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("response" in auth) return auth.response;

  const requestedPageSize = Number(req.nextUrl.searchParams.get("pageSize"));
  const pageSize = [5, 10, 20].includes(requestedPageSize) ? requestedPageSize : 5;
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page")) || 1);
  const [settings, records, total, localUsageBytes] = await Promise.all([
    getSystemBackupSettings(),
    prisma.systemBackupRecord.findMany({ orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.systemBackupRecord.count(),
    getLocalBackupUsageBytes(),
  ]);
  return ok({
    settings: serializeSettings(settings),
    records,
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    localUsageBytes,
  });
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => ({}));
  const localDirectory = String(body.localDirectory ?? "").trim();
  const cloudEnabled = body.cloudEnabled === true;
  const cloudBaseUrl = String(body.cloudBaseUrl ?? "").trim();
  const cloudUsername = String(body.cloudUsername ?? "").trim();
  const cloudDirectory = String(body.cloudDirectory ?? "").trim();
  const cloudPassword = String(body.cloudPassword ?? "");

  if (!localDirectory) return err("请填写服务器本地备份目录");
  if (!path.isAbsolute(localDirectory)) return err("本地备份目录必须是服务器上的绝对路径");
  if (cloudEnabled && (!cloudBaseUrl || !cloudUsername || !cloudDirectory)) {
    return err("启用公司云盘后，请完整填写 WebDAV 地址、账号和目录");
  }
  if (cloudBaseUrl && !/^https?:\/\//i.test(cloudBaseUrl)) return err("WebDAV 地址必须以 http:// 或 https:// 开头");

  const current = await getSystemBackupSettings();
  const settings = await prisma.systemBackupSettings.update({
    where: { id: "default" },
    data: {
      automaticBackupEnabled: body.automaticBackupEnabled !== false,
      intervalHours: SYSTEM_BACKUP_INTERVAL_HOURS,
      localDirectory,
      cloudEnabled,
      cloudProvider: "WEBDAV",
      cloudBaseUrl,
      cloudUsername,
      cloudDirectory,
      cloudPasswordEncrypted: body.clearCloudPassword === true
        ? ""
        : cloudPassword ? encryptAssistantSecret(cloudPassword) : current.cloudPasswordEncrypted,
      updatedBy: auth.user.displayName,
    },
  });
  await prisma.adminAuditLog.create({
    data: {
      actionType: "UPDATE_BACKUP_SETTINGS",
      operator: auth.user.displayName,
      detail: `更新系统备份设置：自动备份${settings.automaticBackupEnabled ? "开启" : "关闭"}，周期 ${SYSTEM_BACKUP_INTERVAL_HOURS} 小时，云盘${settings.cloudEnabled ? "开启" : "关闭"}`,
      snapshot: JSON.stringify({
        localDirectory: settings.localDirectory,
        localLimitBytes: LOCAL_BACKUP_LIMIT_BYTES,
        cloudLimitBytes: CLOUD_BACKUP_LIMIT_BYTES,
        cloudEnabled: settings.cloudEnabled,
        cloudBaseUrl: settings.cloudBaseUrl,
        cloudUsername: settings.cloudUsername,
        cloudDirectory: settings.cloudDirectory,
      }),
    },
  });
  return ok(serializeSettings(settings));
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("response" in auth) return auth.response;
  try {
    const backup = await createSystemBackup({ triggerMode: "MANUAL", operator: auth.user.displayName });
    await prisma.adminAuditLog.create({
      data: {
        actionType: "CREATE_SYSTEM_BACKUP",
        operator: auth.user.displayName,
        detail: `手动创建系统完整备份，状态：${backup.status}`,
        snapshot: JSON.stringify({ backupId: backup.id, status: backup.status, cloudStatus: backup.cloudStatus }),
      },
    });
    return ok(backup, 201);
  } catch (error) {
    return err(error instanceof Error ? error.message : "系统备份失败", 500);
  }
}
