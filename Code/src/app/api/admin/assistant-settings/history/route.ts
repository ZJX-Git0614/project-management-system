import { NextRequest } from "next/server";

import { err, ok } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { requireSystemAdmin } from "@/lib/server-auth";

export async function DELETE(req: NextRequest) {
  const user = await requireSystemAdmin(req);
  if ("status" in user) return user;
  const body = await req.json().catch(() => ({})) as { scope?: string };
  if (body.scope === "chat") {
    const [messages, actions] = await prisma.$transaction([
      prisma.assistantChatMessage.deleteMany(),
      prisma.assistantActionRun.deleteMany(),
      prisma.assistantSettingsHistory.create({
        data: {
          actionType: "CLEAR_CHAT_HISTORY",
          operator: user.displayName,
          summary: "清空助手会话与操作记录",
          snapshot: "{}",
        },
      }),
    ]);
    return ok({
      count: messages.count,
      actionCount: actions.count,
      message: `会话记录已清空，共 ${messages.count} 条会话、${actions.count} 条操作`,
    });
  }
  if (body.scope !== "settings") return err("清理范围不正确");
  const result = await prisma.assistantSettingsHistory.deleteMany();
  await prisma.assistantSettingsHistory.create({
    data: { actionType: "CLEAR_SETTINGS_HISTORY", operator: user.displayName, summary: `清空设置历史，共 ${result.count} 条`, snapshot: "{}" },
  });
  return ok({ count: result.count, message: "设置历史已清空" });
}
