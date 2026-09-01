import { NextRequest } from "next/server";

import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { markCollaborationThreadRead } from "@/lib/collaboration-server";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "collaboration-center:view")) return forbidden();
  try {
    const { threadId } = await params;
    return ok(await markCollaborationThreadRead(threadId, user.userId));
  } catch (error) {
    return err(error instanceof Error ? error.message : "协同消息已读失败");
  }
}
