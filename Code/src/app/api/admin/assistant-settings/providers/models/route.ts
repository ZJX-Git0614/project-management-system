import { NextRequest } from "next/server";

import { err, ok } from "@/lib/api-utils";
import { listAssistantProviderModels } from "@/lib/assistant-provider-client";
import { decryptAssistantSecret } from "@/lib/assistant-secrets";
import type { AssistantRuntimeProvider } from "@/lib/assistant-settings";
import { prisma } from "@/lib/prisma";
import { requireSystemAdmin } from "@/lib/server-auth";

export async function POST(req: NextRequest) {
  const user = await requireSystemAdmin(req);
  if ("status" in user) return user;

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const providerKind = String(body.providerKind || "").toUpperCase();
  const providerType = String(body.providerType || "OPENAI_COMPATIBLE").toUpperCase();
  const baseUrl = String(body.baseUrl || "").trim().replace(/\/$/, "");
  const providerId = String(body.id || "").trim();

  if (!["LLM", "EMBEDDING"].includes(providerKind)) return err("供应商用途不正确");
  if (!["OPENAI_COMPATIBLE", "OLLAMA"].includes(providerType)) return err("供应商协议不支持");
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return err("请填写有效的接口地址");

  const existing = providerId
    ? await prisma.assistantProvider.findUnique({ where: { id: providerId } })
    : null;
  const suppliedApiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

  return ok(await listAssistantProviderModels({
    id: providerId || "provider-draft",
    providerKind: providerKind as AssistantRuntimeProvider["providerKind"],
    providerType: providerType as AssistantRuntimeProvider["providerType"],
    name: String(body.name || existing?.name || "待配置供应商").trim(),
    baseUrl,
    model: String(body.model || existing?.model || "").trim(),
    apiKey: suppliedApiKey || decryptAssistantSecret(existing?.apiKeyEncrypted || ""),
  }));
}
