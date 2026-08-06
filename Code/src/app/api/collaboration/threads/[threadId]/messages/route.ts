import { NextRequest } from "next/server";

import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { getCollaborationThreadForUser, postCollaborationMessage } from "@/lib/collaboration-server";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function GET(req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "collaboration-center:view")) return forbidden();
  const { threadId } = await params;
  const thread = await getCollaborationThreadForUser(threadId, user.userId);
  return thread ? ok(thread.messages) : forbidden();
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "collaboration-center:message")) return forbidden();
  try {
    const { threadId } = await params;
    const body = await req.json() as Record<string, unknown>;
    return ok(await postCollaborationMessage({
      threadId,
      content: String(body.content || ""),
      replyToId: String(body.replyToId || "") || undefined,
      mentionAccountIds: Array.isArray(body.mentionAccountIds) ? body.mentionAccountIds.map(String) : [],
      sender: user,
    }), 201);
  } catch (error) {
    return err(error instanceof Error ? error.message : "协同消息发送失败");
  }
}
