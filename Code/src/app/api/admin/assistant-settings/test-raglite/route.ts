import { NextRequest } from "next/server";

import { ok } from "@/lib/api-utils";
import { loadAssistantRuntimeConfig } from "@/lib/assistant-settings";
import { testRagLiteConnection } from "@/lib/raglite-client";
import { requireSystemAdmin } from "@/lib/server-auth";

export async function POST(req: NextRequest) {
  const user = await requireSystemAdmin(req);
  if ("status" in user) return user;
  return ok(await testRagLiteConnection(await loadAssistantRuntimeConfig()));
}
