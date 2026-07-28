import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";
import { ensureMutableProject, err, notFound, ok, unauthorized } from "@/lib/api-utils";
import { isProjectDocumentFolderName } from "@/lib/project-document-directories";
import {
  buildStoredDocumentName,
  getProjectDocumentPath,
  MAX_PROJECT_DOCUMENT_SIZE_BYTES,
} from "@/lib/project-document-storage";
import { getDocumentWebDavConfig, getSystemBackupSettings } from "@/lib/system-backup";
import { deleteFileFromWebDav, uploadBufferToWebDav } from "@/lib/webdav-backup";

export const runtime = "nodejs";

function serializeDocument(document: {
  id: string;
  projectId: string;
  directoryKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: Date;
  updatedAt: Date;
  storageProvider: string;
  cloudPath: string;
}) {
  return {
    ...document,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const project = await prisma.project.findUnique({ where: { id }, select: { id: true } });
  if (!project) return notFound("项目");

  const documents = await prisma.projectDocumentFile.findMany({
    where: { projectId: id },
    orderBy: [{ directoryKey: "asc" }, { createdAt: "desc" }],
  });

  return ok(documents.map(serializeDocument));
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const formData = await req.formData().catch(() => null);
  if (!formData) return err("无法读取上传内容");

  const directoryKey = String(formData.get("directoryKey") ?? "").trim();
  const storageProvider = String(formData.get("storageProvider") ?? "LOCAL").trim().toUpperCase();
  const file = formData.get("file");

  if (!isProjectDocumentFolderName(directoryKey)) return err("请选择有效的文档文件夹");
  if (!(file instanceof File) || !file.name.trim()) return err("请选择要上传的文件");
  if (file.size === 0) return err("不能上传空文件");
  if (file.size > MAX_PROJECT_DOCUMENT_SIZE_BYTES) return err("单个文件不能超过 20 MB");
  if (!["LOCAL", "CLOUD", "BOTH"].includes(storageProvider)) return err("文档存储位置不正确");

  const documentId = randomUUID();
  const originalName = file.name.trim();
  const storedName = buildStoredDocumentName(documentId, originalName);
  const filePath = getProjectDocumentPath(id, storedName);
  const content = Buffer.from(await file.arrayBuffer());
  let cloudPath = "";

  if (["LOCAL", "BOTH"].includes(storageProvider)) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }

  if (["CLOUD", "BOTH"].includes(storageProvider)) {
    try {
      const settings = await getSystemBackupSettings();
      if (!settings.documentCloudEnabled) throw new Error("请先在系统数据管理中启用并保存项目文档云盘配置");
      cloudPath = await uploadBufferToWebDav(
        getDocumentWebDavConfig(settings),
        [id, directoryKey, storedName],
        content,
        file.type || "application/octet-stream",
      );
    } catch (error) {
      await rm(filePath, { force: true }).catch(() => undefined);
      return err(error instanceof Error ? error.message : "文档上传公司云盘失败");
    }
  }

  try {
    const document = await prisma.$transaction(async (tx) => {
      const created = await tx.projectDocumentFile.create({
        data: {
          id: documentId,
          projectId: id,
          directoryKey,
          originalName,
          storedName,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          uploadedBy: user.displayName,
          storageProvider,
          cloudPath,
        },
      });

      await tx.operationHistory.create({
        data: {
          projectId: id,
          entityType: "PROJECT_DOCUMENT",
          entityId: created.id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `上传文件「${originalName}」至「${directoryKey}」，存储位置：${storageProvider}`,
        },
      });

      return created;
    });

    return ok(serializeDocument(document), 201);
  } catch (error) {
    await rm(filePath, { force: true }).catch(() => undefined);
    if (cloudPath) {
      const settings = await getSystemBackupSettings().catch(() => null);
      if (settings) {
        await deleteFileFromWebDav(getDocumentWebDavConfig(settings), cloudPath).catch(() => undefined);
      }
    }
    throw error;
  }
}
