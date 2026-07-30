import { NextRequest } from "next/server";

import { requireSuperAdmin } from "@/lib/admin-auth";
import { decryptAssistantSecret } from "@/lib/assistant-secrets";
import { err, ok } from "@/lib/api-utils";
import { getSystemBackupSettings } from "@/lib/system-backup";
import { testWebDavConnection } from "@/lib/webdav-backup";

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => ({}));
  const current = await getSystemBackupSettings();
  const target = body.target === "DOCUMENT" ? "DOCUMENT" : "BACKUP";
  try {
    await testWebDavConnection({
      baseUrl: String(target === "DOCUMENT" ? body.documentCloudBaseUrl ?? current.documentCloudBaseUrl : body.cloudBaseUrl ?? current.cloudBaseUrl).trim(),
      username: String(target === "DOCUMENT" ? body.documentCloudUsername ?? current.documentCloudUsername : body.cloudUsername ?? current.cloudUsername).trim(),
      password: String(target === "DOCUMENT" ? body.documentCloudPassword ?? "" : body.cloudPassword ?? "") || decryptAssistantSecret(target === "DOCUMENT" ? current.documentCloudPasswordEncrypted : current.cloudPasswordEncrypted),
      directory: String(target === "DOCUMENT" ? body.documentCloudDirectory ?? current.documentCloudDirectory : body.cloudDirectory ?? current.cloudDirectory).trim(),
    });
    return ok({ message: `${target === "DOCUMENT" ? "项目文档" : "系统备份"}云盘 WebDAV 可读写` });
  } catch (error) {
    return err(error instanceof Error ? error.message : "公司云盘连接失败");
  }
}
