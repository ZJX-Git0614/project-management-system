import { extname, join, resolve } from "node:path";

const configuredRoot = process.env.PROJECT_DOCUMENT_STORAGE_DIR?.trim();

export const PROJECT_DOCUMENT_STORAGE_ROOT = configuredRoot
  ? resolve(configuredRoot)
  : join(process.cwd(), ".local-runtime", "project-documents");

export const MAX_PROJECT_DOCUMENT_SIZE_BYTES = 20 * 1024 * 1024;

export function buildStoredDocumentName(documentId: string, originalName: string): string {
  const extension = extname(originalName);
  const safeExtension = /^\.[a-zA-Z0-9]{1,10}$/.test(extension) ? extension.toLowerCase() : "";
  return `${documentId}${safeExtension}`;
}

export function getProjectDocumentPath(projectId: string, storedName: string): string {
  if (!storedName || storedName.includes("/") || storedName.includes("\\")) {
    throw new Error("无效的文件存储名称");
  }
  return join(getProjectDocumentDirectory(projectId), storedName);
}

export function getProjectDocumentDirectory(projectId: string): string {
  return join(PROJECT_DOCUMENT_STORAGE_ROOT, projectId);
}
