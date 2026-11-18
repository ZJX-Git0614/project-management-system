import { loadAssistantRuntimeConfig } from "@/lib/assistant-settings";
import { prisma } from "@/lib/prisma";

const DAY_MS = 86_400_000;

export type AssistantHistoryCleanupResult = {
  cutoff: Date;
  deleted: {
    messages: number;
    actions: number;
    plans: number;
  };
};

export const cleanupAssistantHistory = async (params: {
  now?: Date;
  historyRetentionDays?: number;
} = {}): Promise<AssistantHistoryCleanupResult> => {
  const historyRetentionDays = params.historyRetentionDays
    ?? (await loadAssistantRuntimeConfig()).historyRetentionDays;
  const cutoff = new Date((params.now ?? new Date()).getTime() - historyRetentionDays * DAY_MS);
  const [messages, actions, plans] = await prisma.$transaction([
    prisma.assistantChatMessage.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.assistantActionRun.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.assistantPlanRun.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);

  return {
    cutoff,
    deleted: {
      messages: messages.count,
      actions: actions.count,
      plans: plans.count,
    },
  };
};
