import { spawn } from "node:child_process";
import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SystemBackupSettings } from "@prisma/client";

import { decryptAssistantSecret } from "@/lib/assistant-secrets";
import { prisma } from "@/lib/prisma";
import { PROJECT_DOCUMENT_STORAGE_ROOT } from "@/lib/project-document-storage";
import {
  ensureWebDavDirectory,
  pruneWebDavBackups,
  uploadFileToWebDav,
  type WebDavBackupConfig,
} from "@/lib/webdav-backup";

export const SYSTEM_BACKUP_INTERVAL_HOURS = 6;
export const LOCAL_BACKUP_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;
export const CLOUD_BACKUP_LIMIT_BYTES = 20 * 1024 * 1024 * 1024;
export const DEFAULT_SYSTEM_BACKUP_ROOT = path.resolve(
  process.env.SYSTEM_BACKUP_DIR?.trim() || path.join(process.cwd(), ".local-runtime", "system-backups"),
);

let backupInProgress = false;

export const postgresToolConnectionUrl = (databaseUrl: string) => {
  const url = new URL(databaseUrl);
  url.searchParams.delete("schema");
  return url.toString();
};

const timestamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

const runCommand = (command: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`${command} 执行失败${stderr.trim() ? `：${stderr.trim()}` : ""}`));
  });
});

const runCommandOutput = (command: string, args: string[]) => new Promise<string>((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0) resolve(stdout);
    else reject(new Error(`${command} 执行失败${stderr.trim() ? `：${stderr.trim()}` : ""}`));
  });
});

export const getSystemBackupSettings = () => prisma.systemBackupSettings.upsert({
  where: { id: "default" },
  create: {
    id: "default",
    automaticBackupEnabled: true,
    intervalHours: SYSTEM_BACKUP_INTERVAL_HOURS,
    localDirectory: DEFAULT_SYSTEM_BACKUP_ROOT,
  },
  update: {},
});

const backupRoot = (settings: SystemBackupSettings) => path.resolve(
  settings.localDirectory.trim() || DEFAULT_SYSTEM_BACKUP_ROOT,
);

const cloudConfig = (settings: SystemBackupSettings): WebDavBackupConfig => ({
  baseUrl: settings.cloudBaseUrl.trim(),
  username: settings.cloudUsername.trim(),
  password: decryptAssistantSecret(settings.cloudPasswordEncrypted),
  directory: settings.cloudDirectory.trim(),
});

const calculateDirectorySize = async (directory: string): Promise<number> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? calculateDirectorySize(target) : (await stat(target)).size;
  }));
  return sizes.reduce((sum, size) => sum + size, 0);
};

export const getLocalBackupUsageBytes = async () => {
  const records = await prisma.systemBackupRecord.findMany({
    where: { backupDirectory: { not: "" } },
    select: { backupDirectory: true, sizeBytes: true },
  });
  const sizes = await Promise.all(records.map((record) => (
    calculateDirectorySize(record.backupDirectory).catch(() => Math.max(0, record.sizeBytes))
  )));
  return sizes.reduce((sum, size) => sum + size, 0);
};

export const selectBackupIdsForPruning = (
  records: Array<{ id: string; createdAt: Date; sizeBytes: number }>,
  maxBytes: number,
) => {
  let totalBytes = records.reduce((sum, record) => sum + Math.max(0, record.sizeBytes), 0);
  const ids: string[] = [];
  for (const record of [...records].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (totalBytes <= maxBytes) break;
    totalBytes -= Math.max(0, record.sizeBytes);
    ids.push(record.id);
  }
  return { ids, totalBytes: Math.max(0, totalBytes) };
};

const pruneLocalBackups = async (settings: SystemBackupSettings, currentRecordId: string) => {
  const records = await prisma.systemBackupRecord.findMany({
    where: { backupDirectory: { not: "" }, sizeBytes: { gt: 0 } },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, sizeBytes: true, backupDirectory: true, cloudStatus: true },
  });
  const measured = await Promise.all(records.map(async (record) => ({
    ...record,
    sizeBytes: await calculateDirectorySize(record.backupDirectory).catch(() => record.sizeBytes),
  })));
  const { ids, totalBytes } = selectBackupIdsForPruning(measured, LOCAL_BACKUP_LIMIT_BYTES);
  const root = backupRoot(settings);
  for (const record of measured.filter((item) => ids.includes(item.id))) {
    const expiredDirectory = path.resolve(record.backupDirectory);
    if (!expiredDirectory.startsWith(`${root}${path.sep}`)) continue;
    await rm(expiredDirectory, { recursive: true, force: true });
    const currentRemoved = record.id === currentRecordId;
    await prisma.systemBackupRecord.update({
      where: { id: record.id },
      data: {
        backupDirectory: "",
        databaseFileName: "",
        documentArchiveFileName: "",
        ...(currentRemoved ? {
          status: record.cloudStatus === "COMPLETED" ? "PARTIAL" : "FAILED",
          errorMessage: record.cloudStatus === "COMPLETED"
            ? "本次备份超过本地 5GB 容量上限，本地文件已清理，云端备份仍可用"
            : "本次备份超过本地 5GB 容量上限，已自动清理",
        } : {}),
      },
    });
  }
  return { totalBytes, currentRemoved: ids.includes(currentRecordId) };
};

const markPrunedCloudRecords = async (directoryNames: string[]) => {
  if (directoryNames.length === 0) return;
  const records = await prisma.systemBackupRecord.findMany({
    where: { cloudStatus: "COMPLETED" },
    select: { id: true, backupDirectory: true, cloudPath: true },
  });
  const removed = new Set(directoryNames);
  await Promise.all(records
    .filter((record) => {
      const localName = record.backupDirectory ? path.basename(record.backupDirectory) : "";
      let cloudName = "";
      try {
        cloudName = decodeURIComponent(new URL(record.cloudPath).pathname).split("/").filter(Boolean).at(-1) || "";
      } catch {
        cloudName = record.cloudPath.split(/[\\/]+/).filter(Boolean).at(-1) || "";
      }
      return removed.has(localName) || removed.has(cloudName);
    })
    .map((record) => prisma.systemBackupRecord.update({
      where: { id: record.id },
      data: { cloudStatus: "PRUNED", cloudPath: "" },
    })));
};

const uploadBackupFilesToCloud = async ({
  settings,
  directory,
  databaseFileName,
  documentArchiveFileName,
}: {
  settings: SystemBackupSettings;
  directory: string;
  databaseFileName: string;
  documentArchiveFileName: string;
}) => {
  const config = cloudConfig(settings);
  const directoryName = path.basename(directory);
  const cloudPath = await ensureWebDavDirectory(config, [directoryName]);
  await uploadFileToWebDav(config, [directoryName, databaseFileName], path.join(directory, databaseFileName));
  await uploadFileToWebDav(config, [directoryName, documentArchiveFileName], path.join(directory, documentArchiveFileName));
  const manifestPath = path.join(directory, "manifest.json");
  if (await access(manifestPath).then(() => true).catch(() => false)) {
    await uploadFileToWebDav(config, [directoryName, "manifest.json"], manifestPath);
  }
  const pruned = await pruneWebDavBackups(config, CLOUD_BACKUP_LIMIT_BYTES);
  await markPrunedCloudRecords(pruned.removed);
  if (pruned.removed.includes(directoryName)) {
    throw new Error("单次备份超过云盘 20GB 容量上限，已自动移除该云端备份");
  }
  return cloudPath;
};

export const createSystemBackup = async ({
  triggerMode,
  operator,
}: {
  triggerMode: "MANUAL" | "AUTOMATIC";
  operator: string;
}) => {
  if (backupInProgress) throw new Error("已有备份任务正在执行");
  backupInProgress = true;
  let recordId = "";
  let directory = "";
  let settings: SystemBackupSettings;
  try {
    settings = await getSystemBackupSettings();
    const recentRunning = await prisma.systemBackupRecord.findFirst({
      where: { status: "RUNNING", createdAt: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
    });
    if (recentRunning) throw new Error("已有备份任务正在执行");
    const record = await prisma.systemBackupRecord.create({
      data: { triggerMode, operator, status: "RUNNING" },
    });
    recordId = record.id;

    const directoryName = `ceastar-pms-${timestamp(record.createdAt)}`;
    directory = path.join(backupRoot(settings), directoryName);
    const databaseFileName = "database.dump";
    const documentArchiveFileName = "project-documents.tar.gz";
    const databasePath = path.join(directory, databaseFileName);
    const documentArchivePath = path.join(directory, documentArchiveFileName);

    if (!process.env.DATABASE_URL) throw new Error("服务器未配置 DATABASE_URL");
    await mkdir(directory, { recursive: true });
    await runCommand("pg_dump", [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--file=${databasePath}`,
      postgresToolConnectionUrl(process.env.DATABASE_URL),
    ]);

    await mkdir(PROJECT_DOCUMENT_STORAGE_ROOT, { recursive: true });
    await runCommand("tar", [
      "-czf",
      documentArchivePath,
      "-C",
      path.dirname(PROJECT_DOCUMENT_STORAGE_ROOT),
      path.basename(PROJECT_DOCUMENT_STORAGE_ROOT),
    ]);

    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
      product: "Ceastar项目管理系统",
      createdAt: record.createdAt.toISOString(),
      triggerMode,
      databaseFile: databaseFileName,
      documentArchiveFile: documentArchiveFileName,
    }, null, 2));

    let cloudStatus = "SKIPPED";
    let cloudPath = "";
    let cloudError = "";
    if (settings.cloudEnabled) {
      try {
        cloudPath = await uploadBackupFilesToCloud({ settings, directory, databaseFileName, documentArchiveFileName });
        cloudStatus = "COMPLETED";
      } catch (error) {
        cloudStatus = "FAILED";
        cloudError = error instanceof Error ? error.message : "云盘上传失败";
      }
    }

    const sizeBytes = await calculateDirectorySize(directory);
    const completed = await prisma.systemBackupRecord.update({
      where: { id: record.id },
      data: {
        completedAt: new Date(),
        status: cloudStatus === "FAILED" ? "PARTIAL" : "COMPLETED",
        backupDirectory: directory,
        databaseFileName,
        documentArchiveFileName,
        sizeBytes: Math.min(sizeBytes, 2_147_483_647),
        cloudStatus,
        cloudPath,
        errorMessage: cloudError,
      },
    });
    await prisma.systemBackupSettings.update({
      where: { id: "default" },
      data: {
        ...(triggerMode === "AUTOMATIC" ? { lastAutomaticBackupAt: new Date() } : {}),
        lastBackupStatus: completed.status,
        lastBackupMessage: cloudError || "备份完成",
      },
    });

    const pruning = await pruneLocalBackups(settings, record.id);
    return pruning.currentRemoved
      ? prisma.systemBackupRecord.findUniqueOrThrow({ where: { id: record.id } })
      : completed;
  } catch (error) {
    const message = error instanceof Error ? error.message : "备份失败";
    if (recordId) {
      await prisma.systemBackupRecord.update({
        where: { id: recordId },
        data: { completedAt: new Date(), status: "FAILED", backupDirectory: directory, errorMessage: message },
      }).catch(() => undefined);
    }
    await prisma.systemBackupSettings.update({
      where: { id: "default" },
      data: { lastBackupStatus: "FAILED", lastBackupMessage: message },
    }).catch(() => undefined);
    throw error;
  } finally {
    backupInProgress = false;
  }
};

export const syncLatestSystemBackupToCloud = async ({ operator }: { operator: string }) => {
  if (backupInProgress) throw new Error("已有备份或云盘同步任务正在执行");
  backupInProgress = true;
  try {
    const settings = await getSystemBackupSettings();
    if (!settings.cloudEnabled) throw new Error("请先启用并保存公司云盘配置");
    const record = await prisma.systemBackupRecord.findFirst({
      where: {
        backupDirectory: { not: "" },
        databaseFileName: { not: "" },
        documentArchiveFileName: { not: "" },
        status: { in: ["COMPLETED", "PARTIAL"] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!record) throw new Error("没有可同步的本地备份，请先执行一次完整备份");
    try {
      const cloudPath = await uploadBackupFilesToCloud({
        settings,
        directory: record.backupDirectory,
        databaseFileName: record.databaseFileName,
        documentArchiveFileName: record.documentArchiveFileName,
      });
      const updated = await prisma.systemBackupRecord.update({
        where: { id: record.id },
        data: { cloudStatus: "COMPLETED", cloudPath, operator, errorMessage: "", status: "COMPLETED" },
      });
      await prisma.systemBackupSettings.update({
        where: { id: "default" },
        data: { lastBackupStatus: "COMPLETED", lastBackupMessage: "最新本地备份已同步到公司云盘" },
      });
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : "云盘同步失败";
      await prisma.systemBackupRecord.update({
        where: { id: record.id },
        data: { cloudStatus: "FAILED", status: "PARTIAL", operator, errorMessage: message },
      });
      await prisma.systemBackupSettings.update({
        where: { id: "default" },
        data: { lastBackupStatus: "PARTIAL", lastBackupMessage: message },
      });
      throw error;
    }
  } finally {
    backupInProgress = false;
  }
};

export const restoreDatabaseDump = async (dumpPath: string) => {
  if (!process.env.DATABASE_URL) throw new Error("服务器未配置 DATABASE_URL");
  await prisma.$disconnect();
  await runCommand("pg_restore", [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
    `--dbname=${postgresToolConnectionUrl(process.env.DATABASE_URL)}`,
    dumpPath,
  ]);
};

export const validateDatabaseDump = async (dumpPath: string) => {
  const contents = await runCommandOutput("pg_restore", ["--list", dumpPath]);
  const requiredTables = ["Project", "UserAccount", "ProjectGanttTask"];
  const missing = requiredTables.filter((table) => !contents.includes(`TABLE DATA public ${table} `));
  if (missing.length > 0) {
    throw new Error(`备份文件不是有效的 Ceastar PMS 数据库备份，缺少：${missing.join("、")}`);
  }
};

export const removeBackupDirectory = (directory: string) => rm(directory, { recursive: true, force: true });

export const isAutomaticBackupDue = (settings: SystemBackupSettings, now = new Date()) => {
  if (!settings.automaticBackupEnabled) return false;
  if (!settings.lastAutomaticBackupAt) return true;
  return now.getTime() - settings.lastAutomaticBackupAt.getTime() >= SYSTEM_BACKUP_INTERVAL_HOURS * 60 * 60 * 1000;
};
