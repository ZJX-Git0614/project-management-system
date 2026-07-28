import { extname, join, resolve } from "node:path";

const configuredRoot = process.env.ASSISTANT_ARTIFACT_STORAGE_DIR?.trim();

export const ASSISTANT_ARTIFACT_STORAGE_ROOT = configuredRoot
  ? resolve(configuredRoot)
  : join(process.cwd(), ".local-runtime", "assistant-artifacts");

const safeStoredName = (value: string) => {
  if (!value || value.includes("/") || value.includes("\\")) throw new Error("无效的助手文件存储名称");
  return value;
};

export const buildAssistantStoredName = (id: string, originalName: string) => {
  const extension = extname(originalName).toLocaleLowerCase("en-US");
  const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
  return `${id}${safeExtension}`;
};

export const getAssistantAttachmentPath = (projectId: string, storedName: string) => (
  join(ASSISTANT_ARTIFACT_STORAGE_ROOT, "attachments", projectId, safeStoredName(storedName))
);

export const getAssistantArtifactPath = (projectId: string, storedName: string) => (
  join(ASSISTANT_ARTIFACT_STORAGE_ROOT, "outputs", projectId, safeStoredName(storedName))
);
