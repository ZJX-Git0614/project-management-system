import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";

import { requireSuperAdmin } from "@/lib/admin-auth";
import { err, notFound } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ backupId: string }> },
) {
  const auth = await requireSuperAdmin(req);
  if ("response" in auth) return auth.response;
  const { backupId } = await params;
  const type = req.nextUrl.searchParams.get("type") === "documents" ? "documents" : "database";
  const record = await prisma.systemBackupRecord.findUnique({ where: { id: backupId } });
  if (!record) return notFound("备份记录");
  const fileName = type === "documents" ? record.documentArchiveFileName : record.databaseFileName;
  if (!record.backupDirectory || !fileName) return err("该备份没有可下载的文件", 404);

  const root = path.resolve(record.backupDirectory);
  const filePath = path.resolve(root, fileName);
  if (!filePath.startsWith(`${root}${path.sep}`)) return err("备份文件路径无效", 400);
  try {
    const file = await readFile(filePath);
    return new Response(new Uint8Array(file), {
      headers: {
        "Content-Type": type === "documents" ? "application/gzip" : "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return err("备份文件不存在或服务器无权读取", 404);
  }
}
