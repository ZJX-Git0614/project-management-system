import { NextRequest } from "next/server";

import { requireSuperAdmin } from "@/lib/admin-auth";
import { err, ok } from "@/lib/api-utils";
import { getSystemBackupSettings, listServerBackupDirectories } from "@/lib/system-backup";

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("response" in auth) return auth.response;

  try {
    const settings = await getSystemBackupSettings();
    return ok(await listServerBackupDirectories(req.nextUrl.searchParams.get("path")?.trim() || "", settings));
  } catch (error) {
    return err(error instanceof Error ? error.message : "无法读取服务器目录");
  }
}
