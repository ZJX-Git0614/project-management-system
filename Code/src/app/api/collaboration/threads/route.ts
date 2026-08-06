import { NextRequest } from "next/server";

import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { createCollaborationThread, listCollaborationThreads } from "@/lib/collaboration-server";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "collaboration-center:view")) return forbidden();
  return ok(await listCollaborationThreads(user.userId, req.nextUrl.searchParams.get("projectId") || undefined));
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "collaboration-center:create")) return forbidden();
  try {
    const body = await req.json() as Record<string, unknown>;
    return ok(await createCollaborationThread({
      projectId: String(body.projectId || ""),
      title: String(body.title || ""),
      entityType: String(body.entityType || ""),
      entityId: String(body.entityId || ""),
      participantAccountIds: Array.isArray(body.participantAccountIds) ? body.participantAccountIds.map(String) : [],
      creator: user,
    }), 201);
  } catch (error) {
    return err(error instanceof Error ? error.message : "协同会话创建失败");
  }
}
