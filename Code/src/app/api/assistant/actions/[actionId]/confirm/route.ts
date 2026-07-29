import { NextRequest } from "next/server";

import { err, notFound, ok } from "@/lib/api-utils";
import { executeAssistantActionAndAdvancePlan } from "@/lib/assistant-plans";
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
    const result = await executeAssistantActionAndAdvancePlan(action, user);
    if (action.messageId) {
      const message = await prisma.assistantChatMessage.findFirst({ where: { id: action.messageId, userId: user.userId } });
      if (message) {
        const blocks = (() => {
          try {
            const parsed = JSON.parse(message.blocks || "[]");
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })();
        const updated = blocks.map((block) => {
          if (!block || typeof block !== "object" || !("action" in block)) return block;
          const currentId = String((block as { action?: { id?: unknown } }).action?.id || "");
          return currentId === action.id ? { type: "action-result", action: result.action } : block;
        });
        if (result.nextAction && !updated.some((block) => block && typeof block === "object" && "action" in block && String((block as { action?: { id?: unknown } }).action?.id || "") === result.nextAction?.id)) {
          updated.push({ type: "action-proposal", action: result.nextAction });
        }
        await prisma.$transaction([
          prisma.assistantChatMessage.update({ where: { id: message.id }, data: { blocks: JSON.stringify(updated) } }),
          ...(result.nextAction ? [prisma.assistantActionRun.update({ where: { id: result.nextAction.id }, data: { messageId: message.id } })] : []),
        ]);
      }
    }
    return ok(result);
  } catch (error) {
    return err(error instanceof Error ? error.message : "执行失败");
  }
}
