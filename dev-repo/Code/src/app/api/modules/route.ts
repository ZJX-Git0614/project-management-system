import { NextRequest } from "next/server";

import { ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { getAuthenticatedUser } from "@/lib/server-auth";
import { getProjectModuleRegistry } from "@/lib/module-registry";

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);

  return ok({
    modules: getProjectModuleRegistry(),
    generatedAt: new Date().toISOString(),
  });
}
