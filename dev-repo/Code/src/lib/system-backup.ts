import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SystemBackupSettings } from "@prisma/client";

import { decryptAssistantSecret } from "@/lib/assistant-secrets";
import { prisma } from "@/lib/prisma";
import { PROJECT_DOCUMENT_STORAGE_ROOT } from "@/lib/project-document-storage";
import { ensureWebDavDirectory, uploadFileToWebDav, type WebDavBackupConfig } from "@/lib/webdav-backup";

export const SYSTEM_BACKUP_INTERVAL_HOURS = 6;
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
        const config = cloudConfig(settings);
        cloudPath = await ensureWebDavDirectory(config, [directoryName]);
        await uploadFileToWebDav(config, [directoryName, databaseFileName], databasePath);
        await uploadFileToWebDav(config, [directoryName, documentArchiveFileName], documentArchivePath);
        await uploadFileToWebDav(config, [directoryName, "manifest.json"], path.join(directory, "manifest.json"));
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

    const expiredRecords = await prisma.systemBackupRecord.findMany({
      where: { status: { in: ["COMPLETED", "PARTIAL"] }, backupDirectory: { not: "" } },
      orderBy: { createdAt: "desc" },
      skip: settings.retentionCount,
    });
    const root = backupRoot(settings);
    for (const expired of expiredRecords) {
      const expiredDirectory = path.resolve(expired.backupDirectory);
      if (expiredDirectory.startsWith(`${root}${path.sep}`)) {
        await rm(expiredDirectory, { recursive: true, force: true });
        await prisma.systemBackupRecord.update({
          where: { id: expired.id },
          data: { backupDirectory: "", databaseFileName: "", documentArchiveFileName: "" },
        });
      }
    }
    return completed;
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
