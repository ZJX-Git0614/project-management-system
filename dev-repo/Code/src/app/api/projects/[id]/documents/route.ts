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
  const file = formData.get("file");

  if (!isProjectDocumentFolderName(directoryKey)) return err("请选择有效的文档文件夹");
  if (!(file instanceof File) || !file.name.trim()) return err("请选择要上传的文件");
  if (file.size === 0) return err("不能上传空文件");
  if (file.size > MAX_PROJECT_DOCUMENT_SIZE_BYTES) return err("单个文件不能超过 20 MB");

  const documentId = randomUUID();
  const originalName = file.name.trim();
  const storedName = buildStoredDocumentName(documentId, originalName);
  const filePath = getProjectDocumentPath(id, storedName);

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(await file.arrayBuffer()));

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
        },
      });

      await tx.operationHistory.create({
        data: {
          projectId: id,
          entityType: "PROJECT_DOCUMENT",
          entityId: created.id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `上传文件「${originalName}」至「${directoryKey}」`,
        },
      });

      return created;
    });

    return ok(serializeDocument(document), 201);
  } catch (error) {
    await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}
