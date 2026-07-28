import { NextRequest } from "next/server";

import { err, ok } from "@/lib/api-utils";
import { encryptAssistantSecret } from "@/lib/assistant-secrets";
import { ensureAssistantSettings, serializeAssistantProvider } from "@/lib/assistant-settings";
import { prisma } from "@/lib/prisma";
import { requireSystemAdmin } from "@/lib/server-auth";

export async function POST(req: NextRequest) {
  const user = await requireSystemAdmin(req);
  if ("status" in user) return user;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const providerKind = String(body.providerKind || "").toUpperCase();
  const providerType = String(body.providerType || "OPENAI_COMPATIBLE").toUpperCase();
  const name = String(body.name || "").trim();
  const baseUrl = String(body.baseUrl || "").trim().replace(/\/$/, "");
  const model = String(body.model || "").trim();
  const apiKey = String(body.apiKey || "").trim();
  if (!["LLM", "EMBEDDING"].includes(providerKind)) return err("供应商用途不正确");
  if (!["OPENAI_COMPATIBLE", "OLLAMA"].includes(providerType)) return err("供应商协议不支持");
  if (!name || !baseUrl || !model) return err("供应商名称、接口地址和模型名称不能为空");
  if (!/^https?:\/\//i.test(baseUrl)) return err("接口地址必须以 http:// 或 https:// 开头");
  await ensureAssistantSettings();
  const duplicate = await prisma.assistantProvider.findUnique({ where: { providerKind_name: { providerKind, name } } });
  if (duplicate) return err("同用途供应商名称已存在");

  const created = await prisma.$transaction(async (tx) => {
    const provider = await tx.assistantProvider.create({
      data: {
        providerKind,
        providerType,
        name,
        baseUrl,
        model,
        apiKeyEncrypted: encryptAssistantSecret(apiKey),
        enabled: body.enabled !== false,
        createdBy: user.displayName,
        updatedBy: user.displayName,
      },
    });
    const settings = await tx.assistantSettings.findUnique({ where: { id: "default" } });
    if (settings && provider.enabled) {
      if (providerKind === "LLM" && !settings.activeLlmProviderId) {
        await tx.assistantSettings.update({ where: { id: "default" }, data: { activeLlmProviderId: provider.id, updatedBy: user.displayName } });
      }
      if (providerKind === "EMBEDDING" && !settings.activeEmbeddingProviderId) {
        await tx.assistantSettings.update({ where: { id: "default" }, data: { activeEmbeddingProviderId: provider.id, updatedBy: user.displayName } });
      }
    }
    await tx.assistantSettingsHistory.create({
      data: {
        actionType: "CREATE_PROVIDER",
        operator: user.displayName,
        summary: `新增${providerKind === "LLM" ? "大语言" : "向量"}模型供应商「${name}」`,
        snapshot: JSON.stringify({ providerId: provider.id, providerKind, providerType, name, baseUrl, model }),
      },
    });
    return provider;
  });
  return ok(serializeAssistantProvider(created), 201);
}
