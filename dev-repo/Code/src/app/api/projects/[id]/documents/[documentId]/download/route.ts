import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";
import { err, notFound, unauthorized } from "@/lib/api-utils";
import { getProjectDocumentPath } from "@/lib/project-document-storage";
import { getSystemBackupSettings, getSystemWebDavConfig } from "@/lib/system-backup";
import { downloadFileFromWebDav } from "@/lib/webdav-backup";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; documentId: string }> },
) {
  const { id, documentId } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const document = await prisma.projectDocumentFile.findFirst({
    where: { id: documentId, projectId: id },
  });
  if (!document) return notFound("文件");

  let file = document.storageProvider !== "CLOUD"
    ? await readFile(getProjectDocumentPath(id, document.storedName)).catch(() => null)
    : null;

  if (!file && document.cloudPath) {
    try {
      const settings = await getSystemBackupSettings();
      file = await downloadFileFromWebDav(getSystemWebDavConfig(settings), document.cloudPath);
    } catch (error) {
      return err(error instanceof Error ? error.message : "从公司云盘读取文件失败", 502);
    }
  }
  if (!file) return err("文件内容不存在，请联系管理员", 404);

  const encodedName = encodeURIComponent(document.originalName).replace(/'/g, "%27");
  return new Response(file, {
    headers: {
      "Content-Type": document.mimeType || "application/octet-stream",
      "Content-Length": String(file.byteLength),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "private, no-store",
    },
  });
}
