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
  try {
    await testWebDavConnection({
      baseUrl: String(body.cloudBaseUrl ?? current.cloudBaseUrl).trim(),
      username: String(body.cloudUsername ?? current.cloudUsername).trim(),
      password: String(body.cloudPassword ?? "") || decryptAssistantSecret(current.cloudPasswordEncrypted),
      directory: String(body.cloudDirectory ?? current.cloudDirectory).trim(),
    });
    return ok({ message: "公司云盘 WebDAV 登录与连接正常" });
  } catch (error) {
    return err(error instanceof Error ? error.message : "公司云盘连接失败");
  }
}
