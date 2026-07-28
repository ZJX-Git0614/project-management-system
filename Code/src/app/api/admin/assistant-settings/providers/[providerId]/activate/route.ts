import { NextRequest } from "next/server";

import { notFound, ok } from "@/lib/api-utils";
import { ensureAssistantSettings } from "@/lib/assistant-settings";
import { prisma } from "@/lib/prisma";
import { requireSystemAdmin } from "@/lib/server-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) {
  const user = await requireSystemAdmin(req);
  if ("status" in user) return user;
  const { providerId } = await params;
  const provider = await prisma.assistantProvider.findUnique({ where: { id: providerId } });
  if (!provider) return notFound("供应商");
  await ensureAssistantSettings();
  await prisma.$transaction(async (tx) => {
    await tx.assistantProvider.update({ where: { id: providerId }, data: { enabled: true, updatedBy: user.displayName } });
    await tx.assistantSettings.update({
      where: { id: "default" },
      data: provider.providerKind === "LLM"
        ? { activeLlmProviderId: providerId, updatedBy: user.displayName }
        : { activeEmbeddingProviderId: providerId, updatedBy: user.displayName },
    });
    await tx.assistantSettingsHistory.create({
      data: { actionType: "ACTIVATE_PROVIDER", operator: user.displayName, summary: `启用供应商「${provider.name}」`, snapshot: JSON.stringify({ providerId }) },
    });
  });
  return ok({ message: `已启用 ${provider.name}` });
}
