import { mkdir, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const configuredRoot = process.env.COLLABORATION_ATTACHMENT_STORAGE_DIR?.trim();

export const COLLABORATION_ATTACHMENT_STORAGE_ROOT = configuredRoot
  ? resolve(configuredRoot)
  : join(process.cwd(), ".local-runtime", "collaboration-attachments");

export const MAX_COLLABORATION_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024;

export const storeCollaborationAttachment = async (threadId: string, file: File) => {
  if (!file.name.trim()) throw new Error("附件名称不能为空");
  if (file.size <= 0) throw new Error("附件内容为空");
  if (file.size > MAX_COLLABORATION_ATTACHMENT_SIZE_BYTES) throw new Error("单个附件不能超过 20 MB");
  const extension = extname(file.name);
  const safeExtension = /^\.[a-zA-Z0-9]{1,10}$/.test(extension) ? extension.toLowerCase() : "";
  const storedName = `${randomUUID()}${safeExtension}`;
  const directory = join(COLLABORATION_ATTACHMENT_STORAGE_ROOT, threadId);
  const storagePath = join(directory, storedName);
  await mkdir(directory, { recursive: true });
  await writeFile(storagePath, Buffer.from(await file.arrayBuffer()));
  return { storedName, storagePath };
};

export const removeStoredCollaborationAttachment = (storagePath: string) => rm(storagePath, { force: true });
