import { rm } from "node:fs/promises";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";
import { ensureMutableProject, err, notFound, ok, unauthorized } from "@/lib/api-utils";
import { getProjectDocumentPath } from "@/lib/project-document-storage";
import { getDocumentWebDavConfig, getSystemBackupSettings } from "@/lib/system-backup";
import { deleteFileFromWebDav } from "@/lib/webdav-backup";

export const runtime = "nodejs";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; documentId: string }> },
) {
  const { id, documentId } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const document = await prisma.projectDocumentFile.findFirst({
    where: { id: documentId, projectId: id },
  });
  if (!document) return notFound("文件");

  if (document.cloudPath) {
    try {
      const settings = await getSystemBackupSettings();
      await deleteFileFromWebDav(getDocumentWebDavConfig(settings), document.cloudPath);
    } catch (error) {
      return err(error instanceof Error ? error.message : "公司云盘文件删除失败", 502);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.projectDocumentFile.delete({ where: { id: document.id } });
    await tx.operationHistory.create({
      data: {
        projectId: id,
        entityType: "PROJECT_DOCUMENT",
        entityId: document.id,
        actionType: "DELETE",
        operator: user.displayName,
        detail: `删除「${document.directoryKey}」中的文件「${document.originalName}」`,
      },
    });
  });

  await rm(getProjectDocumentPath(id, document.storedName), { force: true }).catch(() => undefined);
  return ok({ id: document.id });
}
