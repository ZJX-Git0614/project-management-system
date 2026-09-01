import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { requireSuperAdmin } from "@/lib/admin-auth";
import { err, ok } from "@/lib/api-utils";
import { createProjectRestorePreview, PROJECT_RESTORE_ROOT } from "@/lib/project-restore";
import { validateDatabaseDump } from "@/lib/system-backup";

const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("response" in auth) return auth.response;
  const form = await req.formData();
  const databaseFile = form.get("databaseFile");
  const documentFile = form.get("documentFile");
  if (!(databaseFile instanceof File) || !databaseFile.name.toLowerCase().endsWith(".dump")) return err("请选择系统导出的 database.dump 文件");
  if (databaseFile.size <= 0 || databaseFile.size > MAX_DATABASE_BYTES) return err("数据库备份文件为空或超过 512 MB");
  if (documentFile && (!(documentFile instanceof File) || !documentFile.name.toLowerCase().endsWith(".tar.gz"))) return err("文档备份仅支持 .tar.gz 文件");
  if (documentFile instanceof File && (documentFile.size <= 0 || documentFile.size > MAX_DOCUMENT_BYTES)) return err("文档备份文件为空或超过 2 GB");

  const sessionId = randomUUID();
  const directory = path.join(PROJECT_RESTORE_ROOT, "sessions", sessionId);
  const dumpPath = path.join(directory, "database.dump");
  const documentPath = documentFile instanceof File ? path.join(directory, "project-documents.tar.gz") : "";
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(dumpPath, Buffer.from(await databaseFile.arrayBuffer()));
    if (documentFile instanceof File) await writeFile(documentPath, Buffer.from(await documentFile.arrayBuffer()));
    await validateDatabaseDump(dumpPath);
    const preview = await createProjectRestorePreview({
      sessionId,
      dumpPath,
      sourceFileName: databaseFile.name,
      documentArchivePath: documentPath || undefined,
      documentArchiveFileName: documentFile instanceof File ? documentFile.name : undefined,
    });
    await rm(dumpPath, { force: true });
    return ok(preview);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    return err(error instanceof Error ? error.message : "项目恢复预检失败", 500);
  }
}
