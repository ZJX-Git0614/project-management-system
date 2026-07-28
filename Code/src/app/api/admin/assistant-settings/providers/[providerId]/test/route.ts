import { NextRequest } from "next/server";

import { notFound, ok } from "@/lib/api-utils";
import { testAssistantProviderConnection } from "@/lib/assistant-provider-client";
import { decryptAssistantSecret } from "@/lib/assistant-secrets";
import type { AssistantRuntimeProvider } from "@/lib/assistant-settings";
import { prisma } from "@/lib/prisma";
import { requireSystemAdmin } from "@/lib/server-auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) {
  const user = await requireSystemAdmin(req);
  if ("status" in user) return user;
  const { providerId } = await params;
  const provider = await prisma.assistantProvider.findUnique({ where: { id: providerId } });
  if (!provider) return notFound("供应商");
  return ok(await testAssistantProviderConnection({
    id: provider.id,
    providerKind: provider.providerKind as AssistantRuntimeProvider["providerKind"],
    providerType: provider.providerType as AssistantRuntimeProvider["providerType"],
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    apiKey: decryptAssistantSecret(provider.apiKeyEncrypted),
  }));
}
