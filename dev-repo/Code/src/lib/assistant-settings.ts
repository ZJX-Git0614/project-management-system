import type { AssistantProvider, AssistantSettings } from "@prisma/client";

import {
  normalizeAssistantAvatarPalette,
  normalizeAssistantAvatarStyle,
  type AssistantAvatarPalette,
  type AssistantAvatarStyle,
} from "@/lib/assistant-appearance";
import {
  buildAssistantPersonaInstruction,
  normalizeAssistantPersonaPreset,
  type AssistantPersonaPreset,
} from "@/lib/assistant-persona";
import { decryptAssistantSecret } from "@/lib/assistant-secrets";
import { prisma } from "@/lib/prisma";

export const DEFAULT_ASSISTANT_SYSTEM_PROMPT = [
  "你是 Ceastar 项目管理系统的项目智能助手。",
  "只能使用服务端提供的实时数据库上下文、授权检索片段和工具结果回答。",
  "不得编造项目、人员、金额、日期、任务、事项、风险、文档或操作结果。",
  "涉及写操作时只能提出结构化操作建议，必须等待用户明确确认后才能执行。",
  "用户未选择项目时只能回答项目组合范围信息；选择项目后只处理当前项目数据。",
].join("\n");

export type AssistantProviderKind = "LLM" | "EMBEDDING";
export type AssistantProviderType = "OPENAI_COMPATIBLE" | "OLLAMA";

export type AssistantRuntimeProvider = {
  id: string;
  providerKind: AssistantProviderKind;
  providerType: AssistantProviderType;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
};

export type AssistantRuntimeConfig = {
  enabled: boolean;
  assistantName: string;
  welcomeMessage: string;
  systemPrompt: string;
  personaPreset: AssistantPersonaPreset;
  personaCustomPrompt: string;
  avatarPalette: AssistantAvatarPalette;
  avatarStyle: AssistantAvatarStyle;
  temperature: number;
  maxTokens: number;
  historyLimit: number;
  historyRetentionDays: number;
  retrievalEnabled: boolean;
  retrievalTopK: number;
  chunkMaxSize: number;
  vectorDistanceMetric: "cosine" | "dot" | "l2";
  vectorSearchMultivector: boolean;
  vectorSearchQueryAdapter: boolean;
  rerankerEnabled: boolean;
  agentEnabled: boolean;
  agentEnabledToolIds: string[];
  agentMaxExportRows: number;
  agentActionExpiryMinutes: number;
  ragliteBaseUrl: string;
  ragliteToken: string;
  llmProvider: AssistantRuntimeProvider | null;
  embeddingProvider: AssistantRuntimeProvider | null;
};

export const ASSISTANT_TOOL_CATALOG = [
  { id: "todo.create", label: "创建项目待办", description: "确认后为当前项目创建待办事项", riskLevel: "MEDIUM" },
  { id: "gantt.progress.update", label: "更新任务进度", description: "确认后更新当前项目任务进度", riskLevel: "MEDIUM" },
  { id: "project.export", label: "导出项目数据", description: "导出任务、事项、风险或预算 CSV", riskLevel: "LOW" },
] as const;

const DEFAULT_TOOL_IDS = ASSISTANT_TOOL_CATALOG.map((item) => item.id);

const parseToolIds = (value: string) => {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? Array.from(new Set(parsed.filter((item): item is string => typeof item === "string")))
      : [];
  } catch {
    return [];
  }
};

export const defaultAssistantSettingsData = () => ({
  enabled: true,
  assistantName: "项目智能助手",
  welcomeMessage: "",
  systemPrompt: DEFAULT_ASSISTANT_SYSTEM_PROMPT,
  personaPreset: "PROFESSIONAL",
  personaCustomPrompt: "",
  avatarPalette: "ICE",
  avatarStyle: "ROUNDED",
  temperature: 0.2,
  maxTokens: 1400,
  historyLimit: 12,
  historyRetentionDays: 90,
  retrievalEnabled: false,
  retrievalTopK: 6,
  chunkMaxSize: 2048,
  vectorDistanceMetric: "cosine",
  vectorSearchMultivector: true,
  vectorSearchQueryAdapter: true,
  rerankerEnabled: true,
  agentEnabled: true,
  agentEnabledToolIds: JSON.stringify(DEFAULT_TOOL_IDS),
  agentMaxExportRows: 5000,
  agentActionExpiryMinutes: 15,
  ragliteBaseUrl: process.env.RAGLITE_SERVICE_URL || "",
});

export const ensureAssistantSettings = async () => {
  const existing = await prisma.assistantSettings.findUnique({ where: { id: "default" } });
  if (existing) return existing;
  return prisma.assistantSettings.create({
    data: { id: "default", ...defaultAssistantSettingsData(), updatedBy: "系统初始化" },
  });
};

const runtimeProvider = (provider?: AssistantProvider | null): AssistantRuntimeProvider | null => {
  if (!provider?.enabled) return null;
  return {
    id: provider.id,
    providerKind: provider.providerKind as AssistantProviderKind,
    providerType: provider.providerType as AssistantProviderType,
    name: provider.name,
    baseUrl: provider.baseUrl.replace(/\/$/, ""),
    model: provider.model,
    apiKey: decryptAssistantSecret(provider.apiKeyEncrypted),
  };
};

const environmentLlmProvider = (): AssistantRuntimeProvider | null => {
  const baseUrl = process.env.ASSISTANT_MODEL_BASE_URL;
  const model = process.env.ASSISTANT_MODEL;
  if (!baseUrl || !model) return null;
  return {
    id: "environment-llm",
    providerKind: "LLM",
    providerType: "OPENAI_COMPATIBLE",
    name: "环境变量模型",
    baseUrl: baseUrl.replace(/\/$/, ""),
    model,
    apiKey: process.env.ASSISTANT_MODEL_API_KEY || "",
  };
};

export const loadAssistantRuntimeConfig = async (): Promise<AssistantRuntimeConfig> => {
  const settings = await ensureAssistantSettings();
  const ids = [settings.activeLlmProviderId, settings.activeEmbeddingProviderId].filter((id): id is string => Boolean(id));
  const providers = ids.length ? await prisma.assistantProvider.findMany({ where: { id: { in: ids } } }) : [];
  const map = new Map(providers.map((provider) => [provider.id, provider]));
  const metric = ["cosine", "dot", "l2"].includes(settings.vectorDistanceMetric)
    ? settings.vectorDistanceMetric as "cosine" | "dot" | "l2"
    : "cosine";
  return {
    enabled: settings.enabled,
    assistantName: settings.assistantName || "项目智能助手",
    welcomeMessage: settings.welcomeMessage,
    systemPrompt: settings.systemPrompt || DEFAULT_ASSISTANT_SYSTEM_PROMPT,
    personaPreset: normalizeAssistantPersonaPreset(settings.personaPreset),
    personaCustomPrompt: settings.personaCustomPrompt,
    avatarPalette: normalizeAssistantAvatarPalette(settings.avatarPalette),
    avatarStyle: normalizeAssistantAvatarStyle(settings.avatarStyle),
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    historyLimit: settings.historyLimit,
    historyRetentionDays: settings.historyRetentionDays,
    retrievalEnabled: settings.retrievalEnabled,
    retrievalTopK: settings.retrievalTopK,
    chunkMaxSize: settings.chunkMaxSize,
    vectorDistanceMetric: metric,
    vectorSearchMultivector: settings.vectorSearchMultivector,
    vectorSearchQueryAdapter: settings.vectorSearchQueryAdapter,
    rerankerEnabled: settings.rerankerEnabled,
    agentEnabled: settings.agentEnabled,
    agentEnabledToolIds: parseToolIds(settings.agentEnabledToolIds),
    agentMaxExportRows: settings.agentMaxExportRows,
    agentActionExpiryMinutes: settings.agentActionExpiryMinutes,
    ragliteBaseUrl: (settings.ragliteBaseUrl || process.env.RAGLITE_SERVICE_URL || "").replace(/\/$/, ""),
    ragliteToken: decryptAssistantSecret(settings.ragliteTokenEncrypted) || process.env.RAGLITE_SERVICE_TOKEN || "",
    llmProvider: runtimeProvider(settings.activeLlmProviderId ? map.get(settings.activeLlmProviderId) : null) || environmentLlmProvider(),
    embeddingProvider: runtimeProvider(settings.activeEmbeddingProviderId ? map.get(settings.activeEmbeddingProviderId) : null),
  };
};

export const serializeAssistantProvider = (provider: AssistantProvider) => ({
  id: provider.id,
  providerKind: provider.providerKind,
  providerType: provider.providerType,
  name: provider.name,
  baseUrl: provider.baseUrl,
  model: provider.model,
  enabled: provider.enabled,
  apiKeyConfigured: Boolean(decryptAssistantSecret(provider.apiKeyEncrypted)),
  createdBy: provider.createdBy,
  updatedBy: provider.updatedBy,
  createdAt: provider.createdAt.toISOString(),
  updatedAt: provider.updatedAt.toISOString(),
});

export const serializeAssistantSettings = (settings: AssistantSettings) => ({
  id: settings.id,
  enabled: settings.enabled,
  assistantName: settings.assistantName,
  welcomeMessage: settings.welcomeMessage,
  systemPrompt: settings.systemPrompt,
  personaPreset: normalizeAssistantPersonaPreset(settings.personaPreset),
  personaCustomPrompt: settings.personaCustomPrompt,
  avatarPalette: normalizeAssistantAvatarPalette(settings.avatarPalette),
  avatarStyle: normalizeAssistantAvatarStyle(settings.avatarStyle),
  temperature: settings.temperature,
  maxTokens: settings.maxTokens,
  historyLimit: settings.historyLimit,
  historyRetentionDays: settings.historyRetentionDays,
  retrievalEnabled: settings.retrievalEnabled,
  retrievalTopK: settings.retrievalTopK,
  chunkMaxSize: settings.chunkMaxSize,
  vectorDistanceMetric: settings.vectorDistanceMetric,
  vectorSearchMultivector: settings.vectorSearchMultivector,
  vectorSearchQueryAdapter: settings.vectorSearchQueryAdapter,
  rerankerEnabled: settings.rerankerEnabled,
  agentEnabled: settings.agentEnabled,
  agentEnabledToolIds: parseToolIds(settings.agentEnabledToolIds),
  agentMaxExportRows: settings.agentMaxExportRows,
  agentActionExpiryMinutes: settings.agentActionExpiryMinutes,
  ragliteBaseUrl: settings.ragliteBaseUrl,
  ragliteTokenConfigured: Boolean(decryptAssistantSecret(settings.ragliteTokenEncrypted)),
  activeLlmProviderId: settings.activeLlmProviderId,
  activeEmbeddingProviderId: settings.activeEmbeddingProviderId,
  updatedBy: settings.updatedBy,
  updatedAt: settings.updatedAt.toISOString(),
});

export const assistantSettingsSnapshot = (settings: AssistantSettings) => ({
  ...serializeAssistantSettings(settings),
  systemPrompt: undefined,
  welcomeMessage: undefined,
  updatedAt: undefined,
});

export const assistantModelSystemPrompt = (runtime: AssistantRuntimeConfig) => [
  runtime.systemPrompt,
  buildAssistantPersonaInstruction(runtime.personaPreset, runtime.personaCustomPrompt),
].join("\n\n");
