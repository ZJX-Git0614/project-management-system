import { NextRequest } from "next/server";

import { err, ok } from "@/lib/api-utils";
import {
  ASSISTANT_TOOL_CATALOG,
  assistantSettingsSnapshot,
  ensureAssistantSettings,
  serializeAssistantProvider,
  serializeAssistantSettings,
} from "@/lib/assistant-settings";
import {
  ASSISTANT_AVATAR_PALETTE_OPTIONS,
  ASSISTANT_AVATAR_STYLE_OPTIONS,
  normalizeAssistantAvatarPalette,
  normalizeAssistantAvatarStyle,
} from "@/lib/assistant-appearance";
import { ASSISTANT_PERSONA_OPTIONS, normalizeAssistantPersonaPreset } from "@/lib/assistant-persona";
import { encryptAssistantSecret } from "@/lib/assistant-secrets";
import { prisma } from "@/lib/prisma";
import { requireSystemAdmin } from "@/lib/server-auth";

const clamp = (value: unknown, fallback: number, min: number, max: number, integer = true) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const next = Math.min(max, Math.max(min, parsed));
  return integer ? Math.round(next) : next;
};

const readResponse = async () => {
  const settings = await ensureAssistantSettings();
  const [providers, history] = await Promise.all([
    prisma.assistantProvider.findMany({ orderBy: [{ providerKind: "asc" }, { createdAt: "asc" }] }),
    prisma.assistantSettingsHistory.findMany({ orderBy: { createdAt: "desc" }, take: 80 }),
  ]);
  return {
    settings: serializeAssistantSettings(settings),
    providers: providers.map(serializeAssistantProvider),
    agentTools: ASSISTANT_TOOL_CATALOG,
    personaOptions: ASSISTANT_PERSONA_OPTIONS,
    avatarPaletteOptions: ASSISTANT_AVATAR_PALETTE_OPTIONS,
    avatarStyleOptions: ASSISTANT_AVATAR_STYLE_OPTIONS,
    history: history.map((item) => ({
      id: item.id,
      actionType: item.actionType,
      operator: item.operator,
      summary: item.summary,
      createdAt: item.createdAt.toISOString(),
    })),
  };
};

export async function GET(req: NextRequest) {
  const user = await requireSystemAdmin(req);
  if ("status" in user) return user;
  return ok(await readResponse());
}

export async function PUT(req: NextRequest) {
  const user = await requireSystemAdmin(req);
  if ("status" in user) return user;
  const current = await ensureAssistantSettings();
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  const assistantName = String(body.assistantName ?? current.assistantName).trim();
  const welcomeMessage = String(body.welcomeMessage ?? current.welcomeMessage).trim();
  const systemPrompt = String(body.systemPrompt ?? current.systemPrompt).trim();
  if (!assistantName || assistantName.length > 30) return err("助手名称应为 1-30 个字");
  if (welcomeMessage.length > 500) return err("欢迎语不能超过 500 个字");
  if (!systemPrompt || systemPrompt.length > 12_000) return err("系统提示词应为 1-12000 个字");

  const personaValue = String(body.personaPreset ?? current.personaPreset);
  if (!ASSISTANT_PERSONA_OPTIONS.some((item) => item.value === personaValue)) return err("助手人设不支持");
  const personaPreset = normalizeAssistantPersonaPreset(personaValue);
  const personaCustomPrompt = String(body.personaCustomPrompt ?? current.personaCustomPrompt).trim();
  if (personaPreset === "CUSTOM" && !personaCustomPrompt) return err("请填写自定义人设说明");
  if (personaCustomPrompt.length > 2000) return err("自定义人设不能超过 2000 个字");

  const paletteValue = String(body.avatarPalette ?? current.avatarPalette);
  const styleValue = String(body.avatarStyle ?? current.avatarStyle);
  if (!ASSISTANT_AVATAR_PALETTE_OPTIONS.some((item) => item.value === paletteValue)) return err("助手颜色不支持");
  if (!ASSISTANT_AVATAR_STYLE_OPTIONS.some((item) => item.value === styleValue)) return err("助手样式不支持");

  const toolIds = Array.isArray(body.agentEnabledToolIds)
    ? Array.from(new Set(body.agentEnabledToolIds.filter((item): item is string => typeof item === "string")))
    : JSON.parse(current.agentEnabledToolIds || "[]") as string[];
  const supportedTools = new Set(ASSISTANT_TOOL_CATALOG.map((item) => item.id));
  const unsupported = toolIds.filter((id) => !supportedTools.has(id as typeof ASSISTANT_TOOL_CATALOG[number]["id"]));
  if (unsupported.length) return err(`Agent 工具不支持：${unsupported.join("、")}`);

  const metric = String(body.vectorDistanceMetric ?? current.vectorDistanceMetric);
  if (!["cosine", "dot", "l2"].includes(metric)) return err("向量距离算法不支持");
  const ragliteToken = typeof body.ragliteToken === "string" ? body.ragliteToken.trim() : "";
  const ragliteTokenEncrypted = body.clearRagliteToken === true
    ? ""
    : ragliteToken ? encryptAssistantSecret(ragliteToken) : current.ragliteTokenEncrypted;

  const updated = await prisma.$transaction(async (tx) => {
    const settings = await tx.assistantSettings.update({
      where: { id: "default" },
      data: {
        enabled: body.enabled !== false,
        assistantName,
        welcomeMessage,
        systemPrompt,
        personaPreset,
        personaCustomPrompt,
        avatarPalette: normalizeAssistantAvatarPalette(paletteValue),
        avatarStyle: normalizeAssistantAvatarStyle(styleValue),
        temperature: clamp(body.temperature, current.temperature, 0, 2, false),
        maxTokens: clamp(body.maxTokens, current.maxTokens, 128, 32_768),
        historyLimit: clamp(body.historyLimit, current.historyLimit, 0, 50),
        historyRetentionDays: clamp(body.historyRetentionDays, current.historyRetentionDays, 1, 3650),
        retrievalEnabled: body.retrievalEnabled === true,
        retrievalTopK: clamp(body.retrievalTopK, current.retrievalTopK, 1, 20),
        chunkMaxSize: clamp(body.chunkMaxSize, current.chunkMaxSize, 256, 8192),
        vectorDistanceMetric: metric,
        vectorSearchMultivector: body.vectorSearchMultivector !== false,
        vectorSearchQueryAdapter: body.vectorSearchQueryAdapter !== false,
        rerankerEnabled: body.rerankerEnabled !== false,
        agentEnabled: body.agentEnabled !== false,
        agentEnabledToolIds: JSON.stringify(toolIds),
        agentMaxExportRows: clamp(body.agentMaxExportRows, current.agentMaxExportRows, 100, 50_000),
        agentActionExpiryMinutes: clamp(body.agentActionExpiryMinutes, current.agentActionExpiryMinutes, 1, 60),
        ragliteBaseUrl: String(body.ragliteBaseUrl ?? current.ragliteBaseUrl).trim().replace(/\/$/, ""),
        ragliteTokenEncrypted,
        updatedBy: user.displayName,
      },
    });
    await tx.assistantSettingsHistory.create({
      data: {
        actionType: "UPDATE_SETTINGS",
        operator: user.displayName,
        summary: "更新智能助手基础、人设、模型、知识库、Agent 或历史设置",
        snapshot: JSON.stringify(assistantSettingsSnapshot(settings)),
      },
    });
    return settings;
  });

  return ok({ settings: serializeAssistantSettings(updated), message: "智能助手设置已保存" });
}
