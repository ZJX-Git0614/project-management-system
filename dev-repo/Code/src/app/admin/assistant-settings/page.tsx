"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  BrainCircuit,
  Check,
  Clock3,
  Database,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Sparkles,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import { emitAssistantSettingsChanged } from "@/lib/assistant-events";
import { cn } from "@/lib/utils";

type SettingsTab = "BASIC" | "PROVIDERS" | "KNOWLEDGE" | "AGENT" | "HISTORY";

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

const EMPTY_PROVIDER: ProviderDraft = {
  providerKind: "LLM",
  providerType: "OPENAI_COMPATIBLE",
  name: "",
  baseUrl: "",
  model: "",
  apiKey: "",
  enabled: true,
};

const TAB_ITEMS: Array<{ id: SettingsTab; label: string; icon: typeof Bot }> = [
  { id: "BASIC", label: "基础与人设", icon: Sparkles },
  { id: "PROVIDERS", label: "模型供应商", icon: BrainCircuit },
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

const SettingToggle = ({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className="group flex w-full items-center justify-between gap-4 rounded-md border border-border bg-background/35 px-3 py-2.5 text-left transition-[border-color,background-color,transform] hover:border-primary/30 hover:bg-primary/[0.05] active:scale-[0.995]"
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
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(EMPTY_PROVIDER);
  const [providerSaving, setProviderSaving] = useState(false);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);
  const [ragToken, setRagToken] = useState("");

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

  const openNewProvider = () => {
    setProviderDraft(EMPTY_PROVIDER);
    setProviderOpen(true);
  };

  const openEditProvider = (provider: ProviderItem) => {
    setProviderDraft({
      id: provider.id,
      providerKind: provider.providerKind,
      providerType: provider.providerType,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: "",
      enabled: provider.enabled,
    });
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

  const providerAction = async (provider: ProviderItem, action: "test" | "activate" | "delete" | "models") => {
    if (action === "delete" && !(await confirm(`确认删除供应商「${provider.name}」？`))) return;
    setBusyProviderId(provider.id);
    try {
      if (action === "delete") {
        await api.delete(`/api/admin/assistant-settings/providers/${provider.id}`);
        notify("供应商已删除", "success");
      } else if (action === "activate") {
        const result = await api.post<{ message: string }>(`/api/admin/assistant-settings/providers/${provider.id}/activate`);
        notify(result.message, "success");
      } else if (action === "models") {
        const result = await api.get<{ ok: boolean; message: string; models: string[] }>(`/api/admin/assistant-settings/providers/${provider.id}/models`);
        notify(result.models.length ? `可用模型：${result.models.join("、")}` : result.message, result.ok ? "success" : "warning");
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
        <Card><CardHeader className="flex-row items-center justify-between"><div><CardTitle className="text-sm">模型供应商</CardTitle><CardDescription className="text-xs">大语言模型与向量模型</CardDescription></div><Button size="sm" onClick={openNewProvider}><Plus />新增供应商</Button></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>用途</TableHead><TableHead>供应商</TableHead><TableHead>协议</TableHead><TableHead>模型</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{data.providers.map((provider) => { const active = draft.activeLlmProviderId === provider.id || draft.activeEmbeddingProviderId === provider.id; return <TableRow key={provider.id}><TableCell><Badge variant="outline">{provider.providerKind === "LLM" ? "大语言模型" : "向量模型"}</Badge></TableCell><TableCell><button type="button" className="font-medium hover:text-primary" onClick={() => openEditProvider(provider)}>{provider.name}</button><div className="max-w-[260px] truncate text-[10px] text-muted-foreground">{provider.baseUrl}</div></TableCell><TableCell>{provider.providerType === "OLLAMA" ? "Ollama" : "OpenAI 兼容"}</TableCell><TableCell>{provider.model}</TableCell><TableCell>{active ? <Badge variant="success">使用中</Badge> : provider.enabled ? <Badge variant="secondary">可用</Badge> : <Badge variant="outline">停用</Badge>}</TableCell><TableCell><div className="flex justify-end gap-1"><Button variant="ghost" size="sm" disabled={busyProviderId === provider.id} onClick={() => void providerAction(provider, "test")}>测试</Button><Button variant="ghost" size="sm" disabled={active || busyProviderId === provider.id} onClick={() => void providerAction(provider, "activate")}>启用</Button><Button variant="ghost" size="icon" disabled={active || busyProviderId === provider.id} onClick={() => void providerAction(provider, "delete")} title="删除供应商"><Trash2 /></Button></div></TableCell></TableRow>; })}</TableBody></Table></CardContent></Card>
      )}

      {tab === "KNOWLEDGE" && (
        <div className="grid gap-4 lg:grid-cols-2"><Card><CardHeader><CardTitle className="text-sm">知识增强</CardTitle></CardHeader><CardContent className="space-y-3"><SettingToggle checked={draft.retrievalEnabled} onChange={(retrievalEnabled) => setDraft({ ...draft, retrievalEnabled })} label="启用 RAG 知识检索" /><Field label="RAGLite 服务地址"><Input value={draft.ragliteBaseUrl} onChange={(event) => setDraft({ ...draft, ragliteBaseUrl: event.target.value })} placeholder="http://127.0.0.1:8001" /></Field><Field label={draft.ragliteTokenConfigured ? "访问令牌（已配置）" : "访问令牌"}><Input type="password" value={ragToken} onChange={(event) => setRagToken(event.target.value)} placeholder={draft.ragliteTokenConfigured ? "留空保持不变" : "可选"} /></Field><Button variant="outline" size="sm" onClick={() => void testRag()}>测试连接</Button></CardContent></Card><Card><CardHeader><CardTitle className="text-sm">检索参数</CardTitle></CardHeader><CardContent className="space-y-3"><div className="grid grid-cols-2 gap-3"><Field label="召回数量"><Input type="number" value={draft.retrievalTopK} onChange={(event) => setDraft({ ...draft, retrievalTopK: Number(event.target.value) })} /></Field><Field label="分块大小"><Input type="number" value={draft.chunkMaxSize} onChange={(event) => setDraft({ ...draft, chunkMaxSize: Number(event.target.value) })} /></Field></div><Field label="向量距离"><Select value={draft.vectorDistanceMetric} onChange={(event) => setDraft({ ...draft, vectorDistanceMetric: event.target.value })}><option value="cosine">Cosine</option><option value="dot">Dot Product</option><option value="l2">L2</option></Select></Field><SettingToggle checked={draft.rerankerEnabled} onChange={(rerankerEnabled) => setDraft({ ...draft, rerankerEnabled })} label="启用重排序" /><SettingToggle checked={draft.vectorSearchQueryAdapter} onChange={(vectorSearchQueryAdapter) => setDraft({ ...draft, vectorSearchQueryAdapter })} label="启用查询适配" /><SettingToggle checked={draft.vectorSearchMultivector} onChange={(vectorSearchMultivector) => setDraft({ ...draft, vectorSearchMultivector })} label="启用多向量检索" /></CardContent></Card></div>
      )}

      {tab === "AGENT" && (
        <Card><CardHeader><CardTitle className="text-sm">Agent 工具</CardTitle></CardHeader><CardContent className="space-y-4"><SettingToggle checked={draft.agentEnabled} onChange={(agentEnabled) => setDraft({ ...draft, agentEnabled })} label="启用 Agent 操作" /><div className="grid gap-2 md:grid-cols-3">{data.agentTools.map((tool) => { const enabled = draft.agentEnabledToolIds.includes(tool.id); return <button key={tool.id} type="button" onClick={() => setDraft({ ...draft, agentEnabledToolIds: enabled ? draft.agentEnabledToolIds.filter((id) => id !== tool.id) : [...draft.agentEnabledToolIds, tool.id] })} className={cn("flex min-h-24 flex-col items-start rounded-md border p-3 text-left transition-[border-color,background-color,transform] active:scale-[0.99]", enabled ? "border-primary/50 bg-primary/10" : "border-border hover:border-primary/25")}><span className="flex w-full items-center justify-between"><span className="text-sm font-medium">{tool.label}</span>{enabled && <Check className="size-4 text-primary" />}</span><span className="mt-1 text-xs leading-5 text-muted-foreground">{tool.description}</span><Badge variant="outline" className="mt-auto">{tool.riskLevel}</Badge></button>; })}</div><div className="grid gap-3 md:grid-cols-2"><Field label="单次最大导出行数"><Input type="number" value={draft.agentMaxExportRows} onChange={(event) => setDraft({ ...draft, agentMaxExportRows: Number(event.target.value) })} /></Field><Field label="操作确认有效期（分钟）"><Input type="number" value={draft.agentActionExpiryMinutes} onChange={(event) => setDraft({ ...draft, agentActionExpiryMinutes: Number(event.target.value) })} /></Field></div></CardContent></Card>
      )}

      {tab === "HISTORY" && (
        <Card><CardHeader className="flex-row items-center justify-between"><div><CardTitle className="text-sm">设置历史</CardTitle><CardDescription className="text-xs">保留 {draft.historyRetentionDays} 天会话记录</CardDescription></div><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => void clearHistory("chat")}>清空会话</Button><Button variant="destructive" size="sm" onClick={() => void clearHistory("settings")}>清空设置历史</Button></div></CardHeader><CardContent><Field label="会话保留天数"><Input className="max-w-40" type="number" value={draft.historyRetentionDays} onChange={(event) => setDraft({ ...draft, historyRetentionDays: Number(event.target.value) })} /></Field><div className="mt-4 divide-y divide-border rounded-md border border-border">{data.history.map((item) => <div key={item.id} className="grid gap-1 px-3 py-2.5 text-xs md:grid-cols-[150px_120px_minmax(0,1fr)]"><span className="text-muted-foreground">{new Date(item.createdAt).toLocaleString("zh-CN")}</span><span className="font-medium">{item.operator || "系统"}</span><span>{item.summary}</span></div>)}{data.history.length === 0 && <div className="py-10 text-center text-sm text-muted-foreground">暂无设置记录</div>}</div></CardContent></Card>
      )}

      <Dialog open={providerOpen} onOpenChange={setProviderOpen}><DialogContent><DialogHeader><DialogTitle>{providerDraft.id ? "编辑供应商" : "新增供应商"}</DialogTitle><DialogDescription>配置 OpenAI 兼容接口或 Ollama 服务</DialogDescription></DialogHeader><div className="grid gap-3"><div className="grid grid-cols-2 gap-3"><Field label="用途"><Select disabled={Boolean(providerDraft.id)} value={providerDraft.providerKind} onChange={(event) => setProviderDraft({ ...providerDraft, providerKind: event.target.value as ProviderDraft["providerKind"] })}><option value="LLM">大语言模型</option><option value="EMBEDDING">向量模型</option></Select></Field><Field label="协议"><Select value={providerDraft.providerType} onChange={(event) => setProviderDraft({ ...providerDraft, providerType: event.target.value as ProviderDraft["providerType"] })}><option value="OPENAI_COMPATIBLE">OpenAI 兼容</option><option value="OLLAMA">Ollama</option></Select></Field></div><Field label="供应商名称"><Input value={providerDraft.name} onChange={(event) => setProviderDraft({ ...providerDraft, name: event.target.value })} /></Field><Field label="接口地址"><Input value={providerDraft.baseUrl} onChange={(event) => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></Field><Field label="模型名称"><Input value={providerDraft.model} onChange={(event) => setProviderDraft({ ...providerDraft, model: event.target.value })} /></Field><Field label={providerDraft.id ? "API Key（留空保持不变）" : "API Key"}><Input type="password" value={providerDraft.apiKey} onChange={(event) => setProviderDraft({ ...providerDraft, apiKey: event.target.value })} /></Field><SettingToggle checked={providerDraft.enabled} onChange={(enabled) => setProviderDraft({ ...providerDraft, enabled })} label="启用供应商" /></div><DialogFooter><Button variant="ghost" onClick={() => setProviderOpen(false)}>取消</Button><Button disabled={providerSaving || !providerDraft.name || !providerDraft.baseUrl || !providerDraft.model} onClick={() => void saveProvider()}>{providerSaving ? <LoaderCircle className="animate-spin" /> : <Settings2 />}保存</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}
