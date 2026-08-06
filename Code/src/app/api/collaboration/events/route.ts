import { NextRequest } from "next/server";

import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user || !await userHasPermission(user, "collaboration-center:view")) {
    return new Response("Unauthorized", { status: 401 });
  }
  const encoder = new TextEncoder();
  let closed = false;
  const requestedCursor = req.nextUrl.searchParams.get("since");
  const parsedCursor = requestedCursor ? new Date(requestedCursor) : new Date(Date.now() - 60_000);
  let cursor = Number.isNaN(parsedCursor.getTime()) ? new Date(Date.now() - 60_000) : parsedCursor;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      send("ready", { connectedAt: new Date().toISOString() });
      while (!closed) {
        const messages = await prisma.collaborationMessage.findMany({
          where: { createdAt: { gt: cursor }, thread: { participants: { some: { accountId: user.userId } } } },
          orderBy: { createdAt: "asc" },
          take: 100,
        }).catch(() => []);
        for (const message of messages) {
          send("message", message);
          cursor = message.createdAt;
        }
        send("heartbeat", { at: new Date().toISOString() });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      controller.close();
    },
    cancel() {
      closed = true;
    },
  });
  req.signal.addEventListener("abort", () => { closed = true; });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
