import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";

import { NextRequest } from "next/server";

import { buildAssistantStoredName, getAssistantAttachmentPath } from "@/lib/assistant-artifact-storage";
import {
  ASSISTANT_ATTACHMENT_EXTENSIONS,
  extractAssistantDocument,
  MAX_ASSISTANT_ATTACHMENT_BYTES,
} from "@/lib/assistant-document-processing";
import { hasAssistantProjectAccess } from "@/lib/assistant-project-access";
import { err, ok } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";
import { buildStoredDocumentName, getProjectDocumentPath } from "@/lib/project-document-storage";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if ("status" in user) return user;
  const formData = await req.formData().catch(() => null);
  if (!formData) return err("无法读取附件内容");
  const projectId = String(formData.get("projectId") || "").trim();
  const scope = String(formData.get("scope") || "CHAT").toUpperCase() === "PROJECT" ? "PROJECT" : "CHAT";
  const file = formData.get("file");
  if (!projectId) return err("请先选择项目");
  if (!(await hasAssistantProjectAccess(user, projectId))) return err("无权访问当前项目", 403);
  if (!(file instanceof File) || !file.name.trim()) return err("请选择要分析的文件");
  if (file.size <= 0) return err("附件为空");
  if (file.size > MAX_ASSISTANT_ATTACHMENT_BYTES) return err("助手附件不能超过 20 MB");
  const extension = extname(file.name).toLocaleLowerCase("en-US");
  if (!ASSISTANT_ATTACHMENT_EXTENSIONS.includes(extension as typeof ASSISTANT_ATTACHMENT_EXTENSIONS[number])) {
    return err("支持 DOCX、XLSX、CSV、文本型 PDF、TXT、MD、MPP 和 XML");
  }

  const id = randomUUID();
  const storedName = buildAssistantStoredName(id, file.name);
  const filePath = getAssistantAttachmentPath(projectId, storedName);
  const buffer = Buffer.from(await file.arrayBuffer());
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer);
  await prisma.assistantAttachment.create({
    data: {
      id,
      projectId,
      userId: user.userId,
      originalName: file.name.trim(),
      storedName,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      scope,
    },
  });

  try {
    const extraction = await extractAssistantDocument(file.name, buffer);
    const projectDocumentId = scope === "PROJECT" ? randomUUID() : null;
    const projectDocumentStoredName = projectDocumentId ? buildStoredDocumentName(projectDocumentId, file.name) : null;
    const projectDocumentPath = projectDocumentStoredName ? getProjectDocumentPath(projectId, projectDocumentStoredName) : null;
    if (projectDocumentPath) {
      await mkdir(dirname(projectDocumentPath), { recursive: true });
      await writeFile(projectDocumentPath, buffer);
    }
    await prisma.$transaction(async (tx) => {
      await tx.documentExtraction.create({
        data: {
          attachmentId: id,
          content: extraction.content,
          structuredJson: JSON.stringify({ format: extraction.format, sections: extraction.sections, metadata: extraction.metadata, truncated: extraction.truncated }),
          diagnosticsJson: JSON.stringify(extraction.diagnostics),
        },
      });
      await tx.assistantAttachment.update({ where: { id }, data: { status: "READY" } });
      if (projectDocumentId && projectDocumentStoredName) {
        await tx.projectDocumentFile.create({
          data: {
            id: projectDocumentId,
            projectId,
            directoryKey: [".mpp", ".xml", ".xlsx", ".csv"].includes(extension) ? "5.2《进度计划》" : "15.3变更管理",
            originalName: file.name.trim(),
            storedName: projectDocumentStoredName,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
            uploadedBy: user.displayName,
          },
        });
      }
      await tx.operationHistory.create({
        data: {
          projectId,
          entityType: "ASSISTANT_ATTACHMENT",
          entityId: id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `上传助手附件「${file.name.trim()}」并完成文本提取`,
        },
      });
    }).catch(async (error) => {
      if (projectDocumentPath) await rm(projectDocumentPath, { force: true }).catch(() => undefined);
      throw error;
    });
    return ok({
      id,
      name: file.name.trim(),
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      scope,
      status: "READY",
      diagnostics: extraction.diagnostics,
      sectionCount: extraction.sections.length,
      excerpt: extraction.content.slice(0, 500),
    }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "附件解析失败";
    await prisma.assistantAttachment.update({ where: { id }, data: { status: "FAILED", errorMessage: message } }).catch(() => undefined);
    if (!await prisma.assistantAttachment.findUnique({ where: { id }, select: { id: true } })) {
      await rm(filePath, { force: true }).catch(() => undefined);
    }
    return err(message, 422);
  }
}
