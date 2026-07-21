import { NextRequest } from "next/server";

import { err, notFound, ok } from "@/lib/api-utils";
import { encryptAssistantSecret } from "@/lib/assistant-secrets";
import { serializeAssistantProvider } from "@/lib/assistant-settings";
import { prisma } from "@/lib/prisma";
import { requireSystemAdmin } from "@/lib/server-auth";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) {
  const user = await requireSystemAdmin(req);
  if ("status" in user) return user;
  const { providerId } = await params;
  const current = await prisma.assistantProvider.findUnique({ where: { id: providerId } });
  if (!current) return notFound("供应商");
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const name = String(body.name ?? current.name).trim();
  const baseUrl = String(body.baseUrl ?? current.baseUrl).trim().replace(/\/$/, "");
  const model = String(body.model ?? current.model).trim();
  const providerType = String(body.providerType ?? current.providerType).toUpperCase();
  if (!name || !baseUrl || !model) return err("供应商名称、接口地址和模型名称不能为空");
  if (!/^https?:\/\//i.test(baseUrl)) return err("接口地址必须以 http:// 或 https:// 开头");
  if (!["OPENAI_COMPATIBLE", "OLLAMA"].includes(providerType)) return err("供应商协议不支持");
  const settings = await prisma.assistantSettings.findUnique({ where: { id: "default" } });
  const active = settings?.activeLlmProviderId === providerId || settings?.activeEmbeddingProviderId === providerId;
  if (active && body.enabled === false) return err("当前使用的供应商不能停用，请先切换供应商");
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const updated = await prisma.$transaction(async (tx) => {
    const provider = await tx.assistantProvider.update({
      where: { id: providerId },
      data: {
        name,
        baseUrl,
        model,
        providerType,
        enabled: body.enabled === undefined ? current.enabled : body.enabled === true,
        apiKeyEncrypted: body.clearApiKey === true ? "" : apiKey ? encryptAssistantSecret(apiKey) : current.apiKeyEncrypted,
        updatedBy: user.displayName,
      },
    });
    await tx.assistantSettingsHistory.create({
      data: { actionType: "UPDATE_PROVIDER", operator: user.displayName, summary: `更新供应商「${name}」`, snapshot: JSON.stringify({ providerId, name, baseUrl, model }) },
    });
    return provider;
  });
  return ok(serializeAssistantProvider(updated));
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ providerId: string }> }) {
  const user = await requireSystemAdmin(req);
  if ("status" in user) return user;
  const { providerId } = await params;
  const provider = await prisma.assistantProvider.findUnique({ where: { id: providerId } });
  if (!provider) return notFound("供应商");
  const settings = await prisma.assistantSettings.findUnique({ where: { id: "default" } });
  if (settings?.activeLlmProviderId === providerId || settings?.activeEmbeddingProviderId === providerId) return err("当前使用的供应商不能删除");
  await prisma.$transaction(async (tx) => {
    await tx.assistantProvider.delete({ where: { id: providerId } });
    await tx.assistantSettingsHistory.create({
      data: { actionType: "DELETE_PROVIDER", operator: user.displayName, summary: `删除供应商「${provider.name}」`, snapshot: JSON.stringify({ providerId }) },
    });
  });
  return ok({ message: "供应商已删除" });
}
