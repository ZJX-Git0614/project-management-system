import { NextRequest } from "next/server";

import { forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { getCollaborationThreadForUser } from "@/lib/collaboration-server";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function GET(req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "collaboration-center:view")) return forbidden();
  const { threadId } = await params;
  const thread = await getCollaborationThreadForUser(threadId, user.userId);
  return thread ? ok(thread) : notFound("协同会话");
}
