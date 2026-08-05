"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  BrainCircuit,
  Check,
  Clock3,
  Database,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Save,
  ServerCog,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Wrench,
} from "lucide-react";

import { useConfirm } from "@/components/confirm-provider";
import { useSystemFeedback } from "@/components/system-feedback-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import { emitAssistantSettingsChanged } from "@/lib/assistant-events";
import type {
  AssistantHostServiceAction,
  AssistantHostServiceName,
  AssistantServiceManagerStatus,
} from "@/lib/assistant-service-manager";
import { cn } from "@/lib/utils";

type SettingsTab = "BASIC" | "PROVIDERS" | "SERVICES" | "KNOWLEDGE" | "AGENT" | "HISTORY";

type ProviderItem = {
  id: string;
  providerKind: "LLM" | "EMBEDDING";
  providerType: "OPENAI_COMPATIBLE" | "OLLAMA";
  name: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  apiKeyConfigured: boolean;
  updatedBy: string;
  updatedAt: string;
};

type SettingsData = {
  enabled: boolean;
  assistantName: string;
  welcomeMessage: string;
  systemPrompt: string;
  personaPreset: string;
  personaCustomPrompt: string;
  avatarPalette: string;
  avatarStyle: string;
  temperature: number;
  maxTokens: number;
  historyLimit: number;
  historyRetentionDays: number;
  retrievalEnabled: boolean;
  retrievalTopK: number;
  chunkMaxSize: number;
  vectorDistanceMetric: string;
  vectorSearchMultivector: boolean;
  vectorSearchQueryAdapter: boolean;
  rerankerEnabled: boolean;
  agentEnabled: boolean;
  agentEnabledToolIds: string[];
  agentMaxExportRows: number;
  agentActionExpiryMinutes: number;
  ragliteBaseUrl: string;
  ragliteTokenConfigured: boolean;
  activeLlmProviderId: string | null;
  activeEmbeddingProviderId: string | null;
  updatedBy: string;
  updatedAt: string;
};

type SettingsResponse = {
  settings: SettingsData;
  providers: ProviderItem[];
  agentTools: Array<{ id: string; label: string; description: string; riskLevel: string }>;
  personaOptions: Array<{ value: string; label: string; description: string }>;
  avatarPaletteOptions: Array<{ value: string; label: string; swatchClassName: string }>;
  avatarStyleOptions: Array<{ value: string; label: string; description: string }>;
  history: Array<{ id: string; actionType: string; operator: string; summary: string; createdAt: string }>;
};

type ProviderDraft = {
  id?: string;
  providerKind: "LLM" | "EMBEDDING";
  providerType: "OPENAI_COMPATIBLE" | "OLLAMA";
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  enabled: boolean;
};

type ProviderModelState = {
  models: string[];
  loading: boolean;
  error: string;
};

type ProviderModelsResponse = {
  ok: boolean;
  message: string;
  models: string[];
};

const emptyProvider = (providerKind: ProviderDraft["providerKind"]): ProviderDraft => ({
  providerKind,
  providerType: "OPENAI_COMPATIBLE",
  name: "",
  baseUrl: "https://api.openai.com/v1",
  model: providerKind === "LLM" ? "gpt-4.1-mini" : "text-embedding-3-small",
  apiKey: "",
  enabled: true,
});

const TAB_ITEMS: Array<{ id: SettingsTab; label: string; icon: typeof Bot }> = [
  { id: "BASIC", label: "基础与人设", icon: Sparkles },
  { id: "PROVIDERS", label: "模型供应商", icon: BrainCircuit },
  { id: "SERVICES", label: "本地服务", icon: ServerCog },
  { id: "KNOWLEDGE", label: "知识库", icon: Database },
  { id: "AGENT", label: "Agent 工具", icon: Wrench },
  { id: "HISTORY", label: "历史记录", icon: Clock3 },
];

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="space-y-1.5">
    <Label className="text-xs text-muted-foreground">{label}</Label>
    {children}
  </div>
);

const SettingToggle = ({ checked, disabled = false, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (value: boolean) => void; label: string }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className="group flex w-full items-center justify-between gap-4 rounded-md border border-border bg-background/35 px-3 py-2.5 text-left transition-[border-color,background-color,transform] hover:border-primary/30 hover:bg-primary/[0.05] active:scale-[0.995] disabled:cursor-not-allowed disabled:opacity-50"
  >
    <span className="text-sm font-medium">{label}</span>
    <span className={cn("relative h-5 w-9 shrink-0 rounded-full border transition-colors", checked ? "border-primary bg-primary" : "border-border bg-muted")}>
      <span className={cn("absolute top-0.5 size-3.5 rounded-full bg-white shadow-sm transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </span>
  </button>
);

export default function AssistantSettingsPage() {
  const confirm = useConfirm();
  const { notify } = useSystemFeedback();
  const [tab, setTab] = useState<SettingsTab>("BASIC");
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(() => emptyProvider("LLM"));
  const [providerSaving, setProviderSaving] = useState(false);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);
  const [providerModels, setProviderModels] = useState<Record<string, ProviderModelState>>({});
  const [providerDraftModels, setProviderDraftModels] = useState<string[]>([]);
  const [providerDraftModelsLoading, setProviderDraftModelsLoading] = useState(false);
  const [providerDraftModelsError, setProviderDraftModelsError] = useState("");
  const [ragToken, setRagToken] = useState("");
  const [serviceStatus, setServiceStatus] = useState<AssistantServiceManagerStatus | null>(null);
  const [serviceLoading, setServiceLoading] = useState(false);
  const [serviceBusy, setServiceBusy] = useState<string | null>(null);
  const [ragLiteDirectory, setRagLiteDirectory] = useState("");
  const [ragLiteExecutable, setRagLiteExecutable] = useState("");
  const [ragLiteArguments, setRagLiteArguments] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<SettingsResponse>("/api/admin/assistant-settings");
      setData(result);
      setDraft(result.settings);
    } catch (error) {
      notify(error instanceof Error ? error.message : "加载助手设置失败", "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);

  const loadServiceStatus = useCallback(async (announce = false) => {
    setServiceLoading(true);
    try {
      const status = await api.get<AssistantServiceManagerStatus>("/api/admin/assistant-services");
      setServiceStatus(status);
      if (status.ragLiteConfiguration) {
        setRagLiteDirectory(status.ragLiteConfiguration.directory || "");
        setRagLiteExecutable(status.ragLiteConfiguration.executable || "");
        setRagLiteArguments(status.ragLiteConfiguration.arguments || "");
      }
      if (announce) notify(status.message, status.available ? "success" : "warning");
    } catch (error) {
      notify(error instanceof Error ? error.message : "读取本地服务状态失败", "error");
    } finally {
      setServiceLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    if (tab === "SERVICES") void loadServiceStatus();
  }, [loadServiceStatus, tab]);

  const runServiceAction = async (service: AssistantHostServiceName, action: AssistantHostServiceAction) => {
    const busyKey = `${service}:${action}`;
    setServiceBusy(busyKey);
    try {
      const result = await api.post<{ message: string; status: AssistantServiceManagerStatus }>("/api/admin/assistant-services", { service, action });
      setServiceStatus(result.status);
      notify(result.message, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "本地服务操作失败", "error");
      await loadServiceStatus();
    } finally {
      setServiceBusy(null);
    }
  };

  const configureRagLite = async () => {
    setServiceBusy("RagLite:Configure");
    try {
      const result = await api.post<{ message: string; status: AssistantServiceManagerStatus }>("/api/admin/assistant-services", {
        operation: "ConfigureRagLite",
        directory: ragLiteDirectory,
        executable: ragLiteExecutable,
        arguments: ragLiteArguments,
      });
      setServiceStatus(result.status);
      notify(result.message, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "RAGLite 配置失败", "error");
    } finally {
      setServiceBusy(null);
    }
  };

  const dirty = useMemo(() => Boolean(data && draft && JSON.stringify(data.settings) !== JSON.stringify(draft)) || Boolean(ragToken), [data, draft, ragToken]);

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      const result = await api.put<{ settings: SettingsData; message: string }>("/api/admin/assistant-settings", {
        ...draft,
        ragliteToken: ragToken,
      });
      setDraft(result.settings);
      setData((current) => current ? { ...current, settings: result.settings } : current);
      setRagToken("");
      emitAssistantSettingsChanged();
      notify(result.message, "success");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败", "error");
    } finally {
      setSaving(false);
    }
  };

  const refreshProviderModels = useCallback(async (provider: ProviderItem, announce = false) => {
    setProviderModels((current) => ({
      ...current,
      [provider.id]: { models: current[provider.id]?.models ?? [provider.model], loading: true, error: "" },
    }));
    try {
      const result = await api.get<ProviderModelsResponse>(`/api/admin/assistant-settings/providers/${provider.id}/models`);
      const models = Array.from(new Set([provider.model, ...result.models].filter(Boolean)));
      setProviderModels((current) => ({
        ...current,
        [provider.id]: { models, loading: false, error: result.ok ? "" : result.message },
      }));
      if (announce) notify(result.message, result.ok ? "success" : "warning");
    } catch (error) {
      const message = error instanceof Error ? error.message : "模型列表获取失败";
      setProviderModels((current) => ({
        ...current,
        [provider.id]: { models: [provider.model], loading: false, error: message },
      }));
      if (announce) notify(message, "warning");
    }
  }, [notify]);

  useEffect(() => {
    if (tab !== "PROVIDERS" || !data) return;
    data.providers.forEach((provider) => {
      if (!providerModels[provider.id]) void refreshProviderModels(provider);
    });
  }, [data, providerModels, refreshProviderModels, tab]);

  const fetchDraftModels = async (candidate: ProviderDraft = providerDraft) => {
    setProviderDraftModelsLoading(true);
    setProviderDraftModelsError("");
    try {
      const result = await api.post<ProviderModelsResponse>("/api/admin/assistant-settings/providers/models", candidate);
      const models = result.ok ? Array.from(new Set([candidate.model, ...result.models].filter(Boolean))) : [];
      setProviderDraftModels(models);
      setProviderDraftModelsError(result.ok ? "" : result.message);
      notify(result.message, result.ok ? "success" : "warning");
    } catch (error) {
      const message = error instanceof Error ? error.message : "模型列表获取失败";
      setProviderDraftModels([]);
      setProviderDraftModelsError(message);
      notify(message, "warning");
    } finally {
      setProviderDraftModelsLoading(false);
    }
  };

  const openNewProvider = (providerKind: ProviderDraft["providerKind"]) => {
    setProviderDraft(emptyProvider(providerKind));
    setProviderDraftModels([]);
    setProviderDraftModelsError("");
    setProviderOpen(true);
  };

  const openEditProvider = (provider: ProviderItem) => {
    const nextDraft: ProviderDraft = {
      id: provider.id,
      providerKind: provider.providerKind,
      providerType: provider.providerType,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: "",
      enabled: provider.enabled,
    };
    setProviderDraft(nextDraft);
    setProviderDraftModels(providerModels[provider.id]?.error ? [] : providerModels[provider.id]?.models ?? [provider.model]);
    setProviderDraftModelsError(providerModels[provider.id]?.error ?? "");
    setProviderOpen(true);
  };

  const saveProvider = async () => {
    if (providerSaving) return;
    setProviderSaving(true);
    try {
      if (providerDraft.id) {
        await api.patch(`/api/admin/assistant-settings/providers/${providerDraft.id}`, providerDraft);
      } else {
        await api.post("/api/admin/assistant-settings/providers", providerDraft);
      }
      setProviderOpen(false);
      notify(providerDraft.id ? "供应商已更新" : "供应商已新增", "success");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存供应商失败", "error");
    } finally {
      setProviderSaving(false);
    }
  };

  const updateProviderModel = async (provider: ProviderItem, model: string) => {
    if (!model || model === provider.model) return;
    setBusyProviderId(provider.id);
    try {
      await api.patch(`/api/admin/assistant-settings/providers/${provider.id}`, { model });
      setData((current) => current ? {
        ...current,
        providers: current.providers.map((item) => item.id === provider.id ? { ...item, model } : item),
      } : current);
      emitAssistantSettingsChanged();
      notify(`默认模型已切换为 ${model}`, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "默认模型更新失败", "error");
    } finally {
      setBusyProviderId(null);
    }
  };

  const providerAction = async (provider: ProviderItem, action: "test" | "activate" | "delete") => {
    if (action === "delete" && !(await confirm(`确认删除供应商「${provider.name}」？`))) return;
    setBusyProviderId(provider.id);
    try {
      if (action === "delete") {
        await api.delete(`/api/admin/assistant-settings/providers/${provider.id}`);
        notify("供应商已删除", "success");
      } else if (action === "activate") {
        const result = await api.post<{ message: string }>(`/api/admin/assistant-settings/providers/${provider.id}/activate`);
        notify(result.message, "success");
      } else {
        const result = await api.post<{ ok: boolean; message: string }>(`/api/admin/assistant-settings/providers/${provider.id}/test`);
        notify(result.message, result.ok ? "success" : "error");
      }
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "操作失败", "error");
    } finally {
      setBusyProviderId(null);
    }
  };

  const testRag = async () => {
    try {
      const result = await api.post<{ ok: boolean; message: string }>("/api/admin/assistant-settings/test-raglite");
      notify(result.message, result.ok ? "success" : "error");
    } catch (error) {
      notify(error instanceof Error ? error.message : "测试失败", "error");
    }
  };

  const clearHistory = async (scope: "chat" | "settings") => {
    if (!(await confirm(scope === "chat" ? "确认清空全部用户的助手会话记录？" : "确认清空助手设置历史？"))) return;
    const token = api.getToken();
    const response = await fetch("/api/admin/assistant-settings/history", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ scope }),
    });
    const payload = await response.json();
    if (!response.ok) return notify(payload.error || "清理失败", "error");
    notify(payload.data.message, "success");
    await load();
  };

  if (loading || !data || !draft) {
    return <div className="flex min-h-[320px] items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />加载智能助手设置...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3 shadow-[var(--app-shadow-soft)]">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-md border border-primary/30 bg-primary/10 text-primary"><Bot className="size-5" /></div>
          <div className="min-w-0">
            <h1 className="text-base font-semibold">智能助手设置</h1>
            <p className="text-xs text-muted-foreground">{draft.assistantName} · {draft.enabled ? "已启用" : "已停用"} · {draft.updatedBy || "系统初始化"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw />刷新</Button>
          <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="animate-spin" /> : <Save />}保存设置</Button>
        </div>
      </div>

      <div className="flex min-w-0 gap-1 overflow-x-auto border-b border-border">
        {TAB_ITEMS.map((item) => {
          const Icon = item.icon;
          return <button key={item.id} type="button" onClick={() => setTab(item.id)} className={cn("relative flex h-9 shrink-0 items-center gap-1.5 px-3 text-xs transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:origin-center after:scale-x-0 after:bg-primary after:transition-transform hover:text-foreground", tab === item.id ? "text-primary after:scale-x-100" : "text-muted-foreground")}><Icon className="size-3.5" />{item.label}</button>;
        })}
      </div>

      {tab === "BASIC" && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Card><CardHeader><CardTitle className="text-sm">基础设置</CardTitle></CardHeader><CardContent className="space-y-4">
            <SettingToggle checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label="启用智能助手" />
            <div className="grid gap-3 md:grid-cols-2"><Field label="助手名称"><Input value={draft.assistantName} onChange={(event) => setDraft({ ...draft, assistantName: event.target.value })} /></Field><Field label="人设"><Select value={draft.personaPreset} onChange={(event) => setDraft({ ...draft, personaPreset: event.target.value })}>{data.personaOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></Field></div>
            <Field label="欢迎语"><Textarea rows={2} value={draft.welcomeMessage} onChange={(event) => setDraft({ ...draft, welcomeMessage: event.target.value })} placeholder="留空时按人设自动生成" /></Field>
            {draft.personaPreset === "CUSTOM" && <Field label="自定义人设"><Textarea rows={3} value={draft.personaCustomPrompt} onChange={(event) => setDraft({ ...draft, personaCustomPrompt: event.target.value })} /></Field>}
            <Field label="系统提示词"><Textarea rows={7} value={draft.systemPrompt} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} /></Field>
            <div className="grid gap-3 md:grid-cols-3"><Field label="温度"><Input type="number" min="0" max="2" step="0.1" value={draft.temperature} onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })} /></Field><Field label="最大输出 Token"><Input type="number" value={draft.maxTokens} onChange={(event) => setDraft({ ...draft, maxTokens: Number(event.target.value) })} /></Field><Field label="会话上下文条数"><Input type="number" value={draft.historyLimit} onChange={(event) => setDraft({ ...draft, historyLimit: Number(event.target.value) })} /></Field></div>
          </CardContent></Card>
          <Card><CardHeader><CardTitle className="text-sm">助手外观</CardTitle></CardHeader><CardContent className="space-y-4"><Field label="配色"><div className="grid grid-cols-5 gap-2">{data.avatarPaletteOptions.map((item) => <button key={item.value} type="button" title={item.label} onClick={() => setDraft({ ...draft, avatarPalette: item.value })} className={cn("grid h-10 place-items-center rounded-md border transition-[border-color,background-color,transform] active:scale-95", draft.avatarPalette === item.value ? "border-primary bg-primary/10" : "border-border bg-background/30 hover:border-primary/30")}><span className={cn("size-4 rounded-full", item.swatchClassName)} /></button>)}</div></Field><Field label="形态"><div className="space-y-2">{data.avatarStyleOptions.map((item) => <button key={item.value} type="button" onClick={() => setDraft({ ...draft, avatarStyle: item.value })} className={cn("flex w-full items-center justify-between rounded-md border px-3 py-2 text-left transition-colors", draft.avatarStyle === item.value ? "border-primary/50 bg-primary/10" : "border-border hover:border-primary/25")}><span><span className="block text-sm font-medium">{item.label}</span><span className="text-xs text-muted-foreground">{item.description}</span></span>{draft.avatarStyle === item.value && <Check className="size-4 text-primary" />}</button>)}</div></Field></CardContent></Card>
        </div>
      )}

      {tab === "PROVIDERS" && (
        <div className="grid gap-4 xl:grid-cols-2">
          {(["LLM", "EMBEDDING"] as const).map((providerKind) => {
            const providers = data.providers.filter((provider) => provider.providerKind === providerKind);
            const activeProviderId = providerKind === "LLM" ? draft.activeLlmProviderId : draft.activeEmbeddingProviderId;
            const KindIcon = providerKind === "LLM" ? BrainCircuit : Database;
            return (
              <Card key={providerKind} className="min-w-0">
                <CardHeader className="flex-row items-start justify-between gap-3 pb-3">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <div className="grid size-8 shrink-0 place-items-center rounded-md border border-primary/20 bg-primary/[0.07] text-primary"><KindIcon className="size-4" /></div>
                    <div>
                      <CardTitle className="text-sm">{providerKind === "LLM" ? "LLM 大语言模型" : "Embedding 向量模型"}</CardTitle>
                      <CardDescription className="mt-1 text-xs">{providerKind === "LLM" ? "负责对话理解、分析与回复生成" : "负责知识库向量化与语义检索"}</CardDescription>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" className="shrink-0" onClick={() => openNewProvider(providerKind)}><Plus />新增</Button>
                </CardHeader>
                <CardContent className="space-y-2">
                  {providers.map((provider) => {
                    const active = activeProviderId === provider.id;
                    const modelState = providerModels[provider.id];
                    const modelOptions = Array.from(new Set([provider.model, ...(modelState?.models ?? [])].filter(Boolean)));
                    return (
                      <div key={provider.id} className="rounded-md border border-border bg-background/25 p-3 transition-colors hover:border-primary/25">
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <button type="button" className="min-w-0 text-left" onClick={() => openEditProvider(provider)}>
                            <span className="flex items-center gap-2">
                              <span className="truncate text-sm font-semibold hover:text-primary">{provider.name}</span>
                              {active ? <Badge variant="success">当前默认</Badge> : provider.enabled ? <Badge variant="secondary">可用</Badge> : <Badge variant="outline">停用</Badge>}
                            </span>
                            <span className="mt-1 block truncate text-[10px] text-muted-foreground">{provider.providerType === "OLLAMA" ? "Ollama" : "OpenAI 兼容"} · {provider.baseUrl}</span>
                          </button>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button variant="ghost" size="sm" disabled={busyProviderId === provider.id} onClick={() => void providerAction(provider, "test")}>测试</Button>
                            {!active && <Button variant="ghost" size="sm" disabled={!provider.enabled || busyProviderId === provider.id} onClick={() => void providerAction(provider, "activate")}>设为默认</Button>}
                            <Button variant="ghost" size="icon" disabled={active || busyProviderId === provider.id} onClick={() => void providerAction(provider, "delete")} title="删除供应商"><Trash2 /></Button>
                          </div>
                        </div>
                        <div className="mt-3 grid gap-1.5">
                          <Label className="text-[11px] text-muted-foreground">默认模型</Label>
                          <div className="flex min-w-0 items-center gap-1.5">
                            <Select
                              className="min-w-0 flex-1"
                              value={provider.model}
                              disabled={!provider.enabled || busyProviderId === provider.id || modelState?.loading}
                              onChange={(event) => void updateProviderModel(provider, event.target.value)}
                            >
                              {modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
                            </Select>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-9 shrink-0"
                              disabled={modelState?.loading}
                              onClick={() => void refreshProviderModels(provider, true)}
                              title="重新获取模型列表"
                            >
                              <RefreshCw className={cn("size-3.5", modelState?.loading && "animate-spin")} />
                            </Button>
                          </div>
                          {modelState?.error && <span className="text-[10px] text-amber-500">{modelState.error}，当前模型仍可继续使用。</span>}
                        </div>
                      </div>
                    );
                  })}
                  {providers.length === 0 && (
                    <div className="grid min-h-28 place-items-center rounded-md border border-dashed border-border text-center text-xs text-muted-foreground">
                      尚未配置{providerKind === "LLM" ? "大语言模型" : "向量模型"}供应商
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {tab === "KNOWLEDGE" && (
        <div className="grid gap-4 lg:grid-cols-2"><Card><CardHeader><CardTitle className="text-sm">知识增强</CardTitle></CardHeader><CardContent className="space-y-3"><SettingToggle checked={draft.retrievalEnabled} onChange={(retrievalEnabled) => setDraft({ ...draft, retrievalEnabled })} label="启用 RAG 知识检索" /><Field label="RAGLite 服务地址"><Input value={draft.ragliteBaseUrl} onChange={(event) => setDraft({ ...draft, ragliteBaseUrl: event.target.value })} placeholder="http://host.docker.internal:8001" /></Field><Field label={draft.ragliteTokenConfigured ? "访问令牌（已配置）" : "访问令牌"}><Input type="password" value={ragToken} onChange={(event) => setRagToken(event.target.value)} placeholder={draft.ragliteTokenConfigured ? "留空保持不变" : "可选"} /></Field><Button variant="outline" size="sm" onClick={() => void testRag()}>测试连接</Button></CardContent></Card><Card><CardHeader><CardTitle className="text-sm">检索参数</CardTitle></CardHeader><CardContent className="space-y-3"><div className="grid grid-cols-2 gap-3"><Field label="召回数量"><Input type="number" value={draft.retrievalTopK} onChange={(event) => setDraft({ ...draft, retrievalTopK: Number(event.target.value) })} /></Field><Field label="分块大小"><Input type="number" value={draft.chunkMaxSize} onChange={(event) => setDraft({ ...draft, chunkMaxSize: Number(event.target.value) })} /></Field></div><Field label="向量距离"><Select value={draft.vectorDistanceMetric} onChange={(event) => setDraft({ ...draft, vectorDistanceMetric: event.target.value })}><option value="cosine">Cosine</option><option value="dot">Dot Product</option><option value="l2">L2</option></Select></Field><SettingToggle checked={draft.rerankerEnabled} onChange={(rerankerEnabled) => setDraft({ ...draft, rerankerEnabled })} label="启用重排序" /><SettingToggle checked={draft.vectorSearchQueryAdapter} onChange={(vectorSearchQueryAdapter) => setDraft({ ...draft, vectorSearchQueryAdapter })} label="启用查询适配" /><SettingToggle checked={draft.vectorSearchMultivector} onChange={(vectorSearchMultivector) => setDraft({ ...draft, vectorSearchMultivector })} label="启用多向量检索" /></CardContent></Card></div>
      )}

      {tab === "SERVICES" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-3">
            <div>
              <div className="text-sm font-medium">Windows 本地推理服务</div>
              <div className="mt-1 text-xs text-muted-foreground">{serviceStatus?.message || "正在读取主机服务状态..."}</div>
            </div>
            <Button variant="ghost" size="sm" disabled={serviceLoading || Boolean(serviceBusy)} onClick={() => void loadServiceStatus(true)}>
              <RefreshCw className={cn("size-3.5", serviceLoading && "animate-spin")} />刷新状态
            </Button>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {(serviceStatus?.services ?? []).map((service) => {
              const disabled = !serviceStatus?.available || Boolean(serviceBusy);
              return (
                <Card key={service.name} className="min-w-0">
                  <CardHeader className="flex-row items-start justify-between gap-3">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <span className={cn("size-2 rounded-full", service.healthy ? "bg-emerald-500" : "bg-muted-foreground/45")} />
                        {service.label}
                      </CardTitle>
                      <CardDescription className="mt-1 text-xs">{service.message}</CardDescription>
                    </div>
                    <Badge variant={service.healthy ? "success" : service.configured ? "secondary" : "outline"}>
                      {service.healthy ? "运行中" : service.configured ? "已停止" : "未配置"}
                    </Badge>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-3 gap-2">
                      <Button variant="ghost" size="sm" disabled={disabled || service.healthy || !service.configured} onClick={() => void runServiceAction(service.name, "Start")}><Play className="size-3.5" />启动</Button>
                      <Button variant="ghost" size="sm" disabled={disabled || !service.healthy} onClick={() => void runServiceAction(service.name, "Stop")}><Square className="size-3.5" />停止</Button>
                      <Button variant="ghost" size="sm" disabled={disabled || !service.configured} onClick={() => void runServiceAction(service.name, "Restart")}><RefreshCw className="size-3.5" />重启</Button>
                    </div>
                    <SettingToggle
                      checked={service.autoStartEnabled}
                      disabled={disabled || !service.configured}
                      label="随 Windows 自动启动"
                      onChange={(enabled) => void runServiceAction(service.name, enabled ? "EnableAutoStart" : "DisableAutoStart")}
                    />
                    {service.healthUrl && <div className="truncate text-[11px] text-muted-foreground" title={service.healthUrl}>健康检查：{service.healthUrl}</div>}
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <Card>
            <CardHeader><CardTitle className="text-sm">RAGLite 启动配置</CardTitle><CardDescription className="text-xs">首次部署或移动 RAGLite 后填写，保存后由 Windows 守护任务管理启动与自启。</CardDescription></CardHeader>
            <CardContent className="grid gap-3 lg:grid-cols-3">
              <Field label="安装目录"><Input value={ragLiteDirectory} onChange={(event) => setRagLiteDirectory(event.target.value)} placeholder="D:\\PMS\\RAGLite" /></Field>
              <Field label="启动程序（可选）"><Input value={ragLiteExecutable} onChange={(event) => setRagLiteExecutable(event.target.value)} placeholder="raglite.exe 或 python.exe" /></Field>
              <Field label="启动参数（可选）"><Input value={ragLiteArguments} onChange={(event) => setRagLiteArguments(event.target.value)} placeholder="-m raglite --host 0.0.0.0 --port 8001" /></Field>
              <div className="lg:col-span-3"><Button size="sm" disabled={!serviceStatus?.available || Boolean(serviceBusy) || (!ragLiteDirectory.trim() && !ragLiteExecutable.trim())} onClick={() => void configureRagLite()}>{serviceBusy === "RagLite:Configure" ? <LoaderCircle className="animate-spin" /> : <Save />}保存 RAGLite 启动配置</Button></div>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "AGENT" && (
        <Card><CardHeader><CardTitle className="text-sm">Agent 工具</CardTitle></CardHeader><CardContent className="space-y-4"><SettingToggle checked={draft.agentEnabled} onChange={(agentEnabled) => setDraft({ ...draft, agentEnabled })} label="启用 Agent 操作" /><div className="grid gap-2 md:grid-cols-3">{data.agentTools.map((tool) => { const enabled = draft.agentEnabledToolIds.includes(tool.id); return <button key={tool.id} type="button" onClick={() => setDraft({ ...draft, agentEnabledToolIds: enabled ? draft.agentEnabledToolIds.filter((id) => id !== tool.id) : [...draft.agentEnabledToolIds, tool.id] })} className={cn("flex min-h-24 flex-col items-start rounded-md border p-3 text-left transition-[border-color,background-color,transform] active:scale-[0.99]", enabled ? "border-primary/50 bg-primary/10" : "border-border hover:border-primary/25")}><span className="flex w-full items-center justify-between"><span className="text-sm font-medium">{tool.label}</span>{enabled && <Check className="size-4 text-primary" />}</span><span className="mt-1 text-xs leading-5 text-muted-foreground">{tool.description}</span><Badge variant="outline" className="mt-auto">{tool.riskLevel}</Badge></button>; })}</div><div className="grid gap-3 md:grid-cols-2"><Field label="单次最大导出行数"><Input type="number" value={draft.agentMaxExportRows} onChange={(event) => setDraft({ ...draft, agentMaxExportRows: Number(event.target.value) })} /></Field><Field label="操作确认有效期（分钟）"><Input type="number" value={draft.agentActionExpiryMinutes} onChange={(event) => setDraft({ ...draft, agentActionExpiryMinutes: Number(event.target.value) })} /></Field></div></CardContent></Card>
      )}

      {tab === "HISTORY" && (
        <Card><CardHeader className="flex-row items-center justify-between"><div><CardTitle className="text-sm">设置历史</CardTitle><CardDescription className="text-xs">保留 {draft.historyRetentionDays} 天会话记录</CardDescription></div><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => void clearHistory("chat")}>清空会话</Button><Button variant="destructive" size="sm" onClick={() => void clearHistory("settings")}>清空设置历史</Button></div></CardHeader><CardContent><Field label="会话保留天数"><Input className="max-w-40" type="number" value={draft.historyRetentionDays} onChange={(event) => setDraft({ ...draft, historyRetentionDays: Number(event.target.value) })} /></Field><div className="mt-4 divide-y divide-border rounded-md border border-border">{data.history.map((item) => <div key={item.id} className="grid gap-1 px-3 py-2.5 text-xs md:grid-cols-[150px_120px_minmax(0,1fr)]"><span className="text-muted-foreground">{new Date(item.createdAt).toLocaleString("zh-CN")}</span><span className="font-medium">{item.operator || "系统"}</span><span>{item.summary}</span></div>)}{data.history.length === 0 && <div className="py-10 text-center text-sm text-muted-foreground">暂无设置记录</div>}</div></CardContent></Card>
      )}

      <Dialog open={providerOpen} onOpenChange={setProviderOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{providerDraft.id ? "编辑" : "新增"}{providerDraft.providerKind === "LLM" ? " LLM" : " Embedding"} 供应商</DialogTitle>
            <DialogDescription>配置接口后自动获取模型列表，并选择该供应商的默认模型。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="用途">
                <div className="flex h-9 items-center rounded-md border border-border bg-muted/25 px-3 text-sm">
                  {providerDraft.providerKind === "LLM" ? "LLM 大语言模型" : "Embedding 向量模型"}
                </div>
              </Field>
              <Field label="协议">
                <Select
                  value={providerDraft.providerType}
                  onChange={(event) => {
                    setProviderDraft({ ...providerDraft, providerType: event.target.value as ProviderDraft["providerType"] });
                    setProviderDraftModels([]);
                    setProviderDraftModelsError("");
                  }}
                >
                  <option value="OPENAI_COMPATIBLE">OpenAI 兼容</option>
                  <option value="OLLAMA">Ollama</option>
                </Select>
              </Field>
            </div>
            <Field label="供应商名称">
              <Input value={providerDraft.name} onChange={(event) => setProviderDraft({ ...providerDraft, name: event.target.value })} />
            </Field>
            <Field label="接口地址">
              <Input value={providerDraft.baseUrl} onChange={(event) => {
                setProviderDraft({ ...providerDraft, baseUrl: event.target.value });
                setProviderDraftModels([]);
                setProviderDraftModelsError("");
              }} placeholder="https://api.example.com/v1" />
            </Field>
            <Field label={providerDraft.id ? "API Key（留空保持不变）" : "API Key"}>
              <Input type="password" value={providerDraft.apiKey} onChange={(event) => {
                setProviderDraft({ ...providerDraft, apiKey: event.target.value });
                setProviderDraftModels([]);
                setProviderDraftModelsError("");
              }} />
            </Field>
            <Field label="默认模型">
              <div className="flex items-center gap-2">
                {providerDraftModels.length > 0 ? (
                  <Select className="min-w-0 flex-1" value={providerDraft.model} onChange={(event) => setProviderDraft({ ...providerDraft, model: event.target.value })}>
                    {providerDraftModels.map((model) => <option key={model} value={model}>{model}</option>)}
                  </Select>
                ) : (
                  <Input className="min-w-0 flex-1" value={providerDraft.model} onChange={(event) => setProviderDraft({ ...providerDraft, model: event.target.value })} placeholder="先获取模型，或手动填写模型名称" />
                )}
                <Button
                  variant="outline"
                  className="shrink-0"
                  disabled={providerDraftModelsLoading || !providerDraft.baseUrl}
                  onClick={() => void fetchDraftModels()}
                >
                  <RefreshCw className={cn(providerDraftModelsLoading && "animate-spin")} />
                  获取模型
                </Button>
              </div>
              {providerDraftModelsError && <div className="text-[11px] text-amber-500">{providerDraftModelsError}</div>}
            </Field>
            <SettingToggle checked={providerDraft.enabled} onChange={(enabled) => setProviderDraft({ ...providerDraft, enabled })} label="启用供应商" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setProviderOpen(false)}>取消</Button>
            <Button disabled={providerSaving || !providerDraft.name || !providerDraft.baseUrl || !providerDraft.model} onClick={() => void saveProvider()}>
              {providerSaving ? <LoaderCircle className="animate-spin" /> : <Settings2 />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
