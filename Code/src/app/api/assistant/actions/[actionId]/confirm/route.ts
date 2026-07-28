import { NextRequest } from "next/server";

import { err, notFound, ok } from "@/lib/api-utils";
import { executeAssistantAction, serializeAssistantAction } from "@/lib/assistant-actions";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ actionId: string }> }) {
  const user = await requireUser(req);
  if ("status" in user) return user;
  const { actionId } = await params;
  const action = await prisma.assistantActionRun.findFirst({
    where: { id: actionId, userId: user.userId },
  });
  if (!action) return notFound("助手操作");
  try {
    return ok({ action: serializeAssistantAction(await executeAssistantAction(action, user)) });
  } catch (error) {
    await prisma.assistantActionRun.updateMany({
      where: { id: action.id, userId: user.userId, status: "EXECUTING" },
      data: {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : "执行失败",
      },
    });
    return err(error instanceof Error ? error.message : "执行失败");
  }
}
