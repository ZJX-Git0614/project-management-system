import { NextRequest } from "next/server";

import { notFound, ok } from "@/lib/api-utils";
import { serializeAssistantAction } from "@/lib/assistant-actions";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ actionId: string }> }) {
  const user = await requireUser(req);
  if ("status" in user) return user;
  const { actionId } = await params;
  const action = await prisma.assistantActionRun.findFirst({ where: { id: actionId, userId: user.userId } });
  if (!action) return notFound("助手操作");
  const updated = action.status === "PROPOSED"
    ? await prisma.assistantActionRun.update({ where: { id: actionId }, data: { status: "CANCELLED" } })
    : action;
  return ok({ action: serializeAssistantAction(updated) });
}
