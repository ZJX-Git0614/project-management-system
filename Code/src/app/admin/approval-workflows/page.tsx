"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlarmClock,
  ArrowDown,
  ArrowUp,
  BarChart3,
  CheckCircle2,
  Clock3,
  FilePenLine,
  GitBranch,
  Plus,
  RefreshCw,
  Save,
  Send,
  Trash2,
  UsersRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { useConfirm } from "@/components/confirm-provider";
import { useSystemFeedback } from "@/components/system-feedback-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import { APPROVAL_BUSINESS_TYPE_LABEL, APPROVAL_INSTANCE_STATUS_LABEL, type ApprovalWorkflowDraftInput, type ApprovalWorkflowNodeInput } from "@/lib/approval-workflow";
import { cn } from "@/lib/utils";
import { usePermission } from "@/lib/use-permission";

type SettingsTab = "WORKFLOW" | "DELEGATION" | "ANALYTICS";

type WorkflowNodeView = ApprovalWorkflowNodeInput & { id: string };

type WorkflowVersionView = {
  id: string;
  version: number;
  status: string;
  triggerPermissionKey: string;
  completionHandlerKey: string;
  config: Record<string, unknown>;
  publishedAt: string | null;
  nodes: WorkflowNodeView[];
};

type WorkflowDefinitionView = {
  id: string;
  businessType: string;
  moduleKey: string;
  name: string;
  description: string;
  enabled: boolean;
  activeVersionNumber: number;
  versions: WorkflowVersionView[];
};

type AccountView = { id: string; displayName: string; username: string; enabled: boolean };
type RoleView = { id: string; roleName: string };
type ProjectView = { id: string; name: string; code: string };

type DelegationView = {
  id: string;
  projectId: string | null;
  fromAccountId: string;
  fromDisplayName: string;
  toAccountId: string;
  toDisplayName: string;
  startsAt: string;
  endsAt: string;
  enabled: boolean;
  reason: string;
};

type AnalyticsView = {
  total: number;
  statusCounts: Record<string, number>;
  businessCounts: Record<string, Record<string, number>>;
  averageCycleHours: number;
  overdue: number;
  activeDelegations: number;
  pendingNodes: Array<{ nodeName: string; count: number }>;
  recent: Array<{
    id: string;
    title: string;
    status: string;
    businessType: string;
    requesterName: string;
    requestedAt: string;
    completedAt: string | null;
    project: { code: string; name: string };
  }>;
};

const toLocalInputValue = (value: Date | string) => {
  const date = typeof value === "string" ? new Date(value) : value;
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

const createDelegationDraft = () => {
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { projectId: "", fromAccountId: "", toAccountId: "", startsAt: toLocalInputValue(startsAt), endsAt: toLocalInputValue(endsAt), reason: "" };
};

const createNode = (index: number): ApprovalWorkflowNodeInput => ({
  nodeKey: `approval-${Date.now()}-${index + 1}`,
  nodeOrder: index + 1,
  nodeType: "APPROVAL",
  nodeName: `审批节点 ${index + 1}`,
  assignmentType: "PROJECT_ROLE",
  projectRoleName: "项目经理",
  accountId: "",
  approvalMode: "ALL",
  requiredApprovals: 1,
  returnTargetNodeKey: "",
  reminderAfterHours: 24,
  reminderIntervalHours: 24,
  conditionConfig: {},
  actionsConfig: [],
});

const draftFrom = (definition: WorkflowDefinitionView, version: WorkflowVersionView): ApprovalWorkflowDraftInput => ({
  businessType: definition.businessType,
  moduleKey: definition.moduleKey,
  name: definition.name,
  description: definition.description,
  enabled: definition.enabled,
  triggerPermissionKey: version.triggerPermissionKey,
  completionHandlerKey: version.completionHandlerKey,
  config: version.config || {},
  nodes: version.nodes.map((node, index) => ({
    nodeKey: node.nodeKey,
    nodeOrder: index + 1,
    nodeType: node.nodeType,
    nodeName: node.nodeName,
    assignmentType: node.assignmentType,
    projectRoleName: node.projectRoleName || "",
    accountId: node.accountId || "",
    approvalMode: node.approvalMode || "ALL",
    requiredApprovals: node.requiredApprovals || 1,
    returnTargetNodeKey: node.returnTargetNodeKey || "",
    reminderAfterHours: node.reminderAfterHours || 24,
    reminderIntervalHours: node.reminderIntervalHours || 24,
    conditionConfig: node.conditionConfig || {},
    actionsConfig: node.actionsConfig || [],
  })),
});

const versionTone = (status: string) => status === "PUBLISHED"
  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
  : status === "DRAFT"
    ? "border-primary/30 bg-primary/10 text-primary"
    : "border-border bg-muted/40 text-muted-foreground";

export default function ApprovalWorkflowSettingsPage() {
  const confirm = useConfirm();
  const { notify } = useSystemFeedback();
  const { can } = usePermission();
  const [tab, setTab] = useState<SettingsTab>("WORKFLOW");
  const [definitions, setDefinitions] = useState<WorkflowDefinitionView[]>([]);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [roles, setRoles] = useState<RoleView[]>([]);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [selectedDefinitionId, setSelectedDefinitionId] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [draft, setDraft] = useState<ApprovalWorkflowDraftInput | null>(null);
  const [delegations, setDelegations] = useState<DelegationView[]>([]);
  const [delegationDraft, setDelegationDraft] = useState(createDelegationDraft);
  const [analytics, setAnalytics] = useState<AnalyticsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadConfiguration = useCallback(async (preferredDefinitionId?: string, preferredVersionId?: string) => {
    setLoading(true);
    try {
      const [workflowData, accountData, roleData, projectData] = await Promise.all([
        api.get<WorkflowDefinitionView[]>("/api/approval-workflows"),
        api.get<AccountView[]>("/api/accounts"),
        api.get<RoleView[]>("/api/role-config"),
        api.get<ProjectView[]>("/api/projects"),
      ]);
      setDefinitions(workflowData);
      setAccounts(accountData.filter((account) => account.enabled));
      setRoles(roleData);
      setProjects(projectData);
      const definition = workflowData.find((item) => item.id === (preferredDefinitionId || selectedDefinitionId)) ?? workflowData[0];
      const version = definition?.versions.find((item) => item.id === preferredVersionId)
        ?? definition?.versions.find((item) => item.status === "DRAFT")
        ?? definition?.versions[0];
      setSelectedDefinitionId(definition?.id ?? "");
      setSelectedVersionId(version?.id ?? "");
      setDraft(definition && version ? draftFrom(definition, version) : null);
    } catch (error) {
      notify(error instanceof Error ? error.message : "审批流程配置加载失败", "error");
    } finally {
      setLoading(false);
    }
  }, [notify, selectedDefinitionId]);

  const loadDelegations = useCallback(async () => {
    try {
      setDelegations(await api.get<DelegationView[]>("/api/approval-delegations"));
    } catch (error) {
      notify(error instanceof Error ? error.message : "审批委托加载失败", "error");
    }
  }, [notify]);

  const loadAnalytics = useCallback(async () => {
    try {
      setAnalytics(await api.get<AnalyticsView>("/api/approval-analytics"));
    } catch (error) {
      notify(error instanceof Error ? error.message : "审批统计加载失败", "error");
    }
  }, [notify]);

  useEffect(() => { void loadConfiguration(); }, [loadConfiguration]);
  useEffect(() => {
    if (tab === "DELEGATION" && can("approval-workflow-config:delegate")) void loadDelegations();
    if (tab === "ANALYTICS" && can("approval-workflow-config:analytics")) void loadAnalytics();
  }, [can, loadAnalytics, loadDelegations, tab]);

  const selectedDefinition = definitions.find((item) => item.id === selectedDefinitionId) ?? null;
  const selectedVersion = selectedDefinition?.versions.find((item) => item.id === selectedVersionId) ?? null;
  const projectNameById = useMemo(() => new Map(projects.map((project) => [project.id, `${project.code || project.name} · ${project.name}`])), [projects]);
  const analyticsMetrics: Array<{ label: string; value: string | number; icon: LucideIcon }> = [
    { label: "审批总量", value: analytics?.total ?? 0, icon: FilePenLine },
    { label: "审批中", value: analytics?.statusCounts.PENDING ?? 0, icon: Clock3 },
    { label: "已通过", value: analytics?.statusCounts.APPROVED ?? 0, icon: CheckCircle2 },
    { label: "已逾期", value: analytics?.overdue ?? 0, icon: AlarmClock },
    { label: "平均周期", value: `${(analytics?.averageCycleHours ?? 0).toFixed(1)} 小时`, icon: BarChart3 },
  ];

  const chooseDefinition = (definitionId: string) => {
    const definition = definitions.find((item) => item.id === definitionId);
    const version = definition?.versions.find((item) => item.status === "DRAFT") ?? definition?.versions[0];
    setSelectedDefinitionId(definitionId);
    setSelectedVersionId(version?.id ?? "");
    setDraft(definition && version ? draftFrom(definition, version) : null);
  };

  const chooseVersion = (versionId: string) => {
    if (!selectedDefinition) return;
    const version = selectedDefinition.versions.find((item) => item.id === versionId);
    setSelectedVersionId(versionId);
    if (version) setDraft(draftFrom(selectedDefinition, version));
  };

  const updateNode = (index: number, patch: Partial<ApprovalWorkflowNodeInput>) => {
    setDraft((current) => current ? {
      ...current,
      nodes: current.nodes.map((node, nodeIndex) => nodeIndex === index ? { ...node, ...patch } : node),
    } : current);
  };

  const moveNode = (index: number, direction: -1 | 1) => {
    setDraft((current) => {
      if (!current) return current;
      const target = index + direction;
      if (target < 0 || target >= current.nodes.length) return current;
      const nodes = [...current.nodes];
      [nodes[index], nodes[target]] = [nodes[target], nodes[index]];
      return { ...current, nodes: nodes.map((node, nodeIndex) => ({ ...node, nodeOrder: nodeIndex + 1 })) };
    });
  };

  const saveDraft = async () => {
    if (!draft || !selectedDefinition) return;
    setBusy(true);
    try {
      const version = await api.post<{ id: string }>("/api/approval-workflows", draft);
      notify("审批流程草稿已保存为新版本", "success");
      await loadConfiguration(selectedDefinition.id, version.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "审批流程草稿保存失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const publishVersion = async () => {
    if (!selectedVersion || selectedVersion.status !== "DRAFT") return;
    if (!await confirm(`确认发布审批流程 v${selectedVersion.version}？发布后新发起的审批将使用该版本，历史审批仍按原快照运行。`)) return;
    setBusy(true);
    try {
      await api.post(`/api/approval-workflows/versions/${selectedVersion.id}/publish`, {});
      notify("审批流程版本已发布", "success");
      await loadConfiguration(selectedDefinitionId, selectedVersion.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "审批流程发布失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const createDelegation = async () => {
    if (!delegationDraft.fromAccountId || !delegationDraft.toAccountId) return notify("请选择委托人和受托人", "warning");
    setBusy(true);
    try {
      await api.post("/api/approval-delegations", {
        ...delegationDraft,
        startsAt: new Date(delegationDraft.startsAt).toISOString(),
        endsAt: new Date(delegationDraft.endsAt).toISOString(),
      });
      setDelegationDraft(createDelegationDraft());
      notify("审批委托已创建", "success");
      await loadDelegations();
    } catch (error) {
      notify(error instanceof Error ? error.message : "审批委托创建失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const toggleDelegation = async (item: DelegationView) => {
    setBusy(true);
    try {
      await api.put(`/api/approval-delegations/${item.id}`, { enabled: !item.enabled });
      await loadDelegations();
    } catch (error) {
      notify(error instanceof Error ? error.message : "审批委托更新失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const deleteDelegation = async (item: DelegationView) => {
    if (!await confirm(`确认删除“${item.fromDisplayName} → ${item.toDisplayName}”的审批委托？已生成的审批任务不会改变。`)) return;
    setBusy(true);
    try {
      await api.delete(`/api/approval-delegations/${item.id}`);
      notify("审批委托已删除", "success");
      await loadDelegations();
    } catch (error) {
      notify(error instanceof Error ? error.message : "审批委托删除失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const remindNow = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ reminded: number }>("/api/approval-reminders/run", {});
      notify(result.reminded > 0 ? `已发送 ${result.reminded} 条审批催办` : "当前没有达到催办时间的审批", result.reminded > 0 ? "success" : "info");
      await loadAnalytics();
    } catch (error) {
      notify(error instanceof Error ? error.message : "审批催办执行失败", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm"><Workflow className="size-4 text-primary" />审批流程配置</CardTitle>
              <CardDescription className="mt-1 text-xs">流程版本发布后只影响新审批；运行中的审批保留发起时的节点快照。</CardDescription>
            </div>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => void loadConfiguration()} disabled={loading || busy}><RefreshCw className={cn("size-3.5", loading && "animate-spin")} />刷新</Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1.5 border-t border-border pt-3">
          {([
            ["WORKFLOW", "流程版本", GitBranch],
            ["DELEGATION", "审批委托", UsersRound],
            ["ANALYTICS", "运行统计", BarChart3],
          ] as const).map(([value, label, Icon]) => (
            <Button key={value} size="sm" variant={tab === value ? "default" : "ghost"} className="h-8 text-xs" onClick={() => setTab(value)}><Icon className="size-3.5" />{label}</Button>
          ))}
        </CardContent>
      </Card>

      {tab === "WORKFLOW" && (
        <div className="grid min-h-[680px] gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
          <Card className="overflow-hidden">
            <CardContent className="p-0">
              {definitions.map((definition) => (
                <button key={definition.id} type="button" onClick={() => chooseDefinition(definition.id)} className={cn("block w-full border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted/40", selectedDefinitionId === definition.id && "bg-primary/10")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{definition.name}</span>
                    <Badge variant="secondary" className="text-[10px]">v{definition.activeVersionNumber || "--"}</Badge>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">{APPROVAL_BUSINESS_TYPE_LABEL[definition.businessType] ?? definition.businessType}</div>
                </button>
              ))}
              {!loading && definitions.length === 0 && <div className="px-4 py-12 text-center text-xs text-muted-foreground">暂无审批流程</div>}
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            {!draft || !selectedDefinition || !selectedVersion ? (
              <CardContent className="flex min-h-[420px] items-center justify-center text-sm text-muted-foreground">选择流程后维护版本</CardContent>
            ) : (
              <>
                <CardHeader className="border-b border-border pb-4">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <CardTitle className="text-base">{selectedDefinition.name}</CardTitle>
                      <CardDescription className="mt-1 text-xs">业务类型：{selectedDefinition.businessType}</CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select value={selectedVersionId} onChange={(event) => chooseVersion(event.target.value)} className="h-8 w-40 text-xs">
                        {selectedDefinition.versions.map((version) => <option key={version.id} value={version.id}>v{version.version} · {version.status === "PUBLISHED" ? "已发布" : version.status === "DRAFT" ? "草稿" : "已停用"}</option>)}
                      </Select>
                      <Badge className={cn("text-[10px]", versionTone(selectedVersion.status))}>{selectedVersion.status}</Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5 pt-4">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">流程名称</Label><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="h-8 text-xs" /></div>
                    <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">所属模块</Label><Input value={draft.moduleKey} onChange={(event) => setDraft({ ...draft, moduleKey: event.target.value })} className="h-8 text-xs" /></div>
                    <div className="space-y-1.5 md:col-span-2"><Label className="text-xs text-muted-foreground">流程说明</Label><Textarea value={draft.description || ""} onChange={(event) => setDraft({ ...draft, description: event.target.value })} className="min-h-16 text-xs" /></div>
                    <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">触发权限键</Label><Input value={draft.triggerPermissionKey || ""} onChange={(event) => setDraft({ ...draft, triggerPermissionKey: event.target.value })} className="h-8 font-mono text-xs" /></div>
                    <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">业务完成处理器</Label><Input value={draft.completionHandlerKey || ""} readOnly className="h-8 bg-muted/20 font-mono text-xs text-muted-foreground" /></div>
                  </div>

                  <section className="space-y-2 border-t border-border pt-4">
                    <div className="flex items-center justify-between gap-3">
                      <div><h2 className="text-sm font-semibold">审批节点</h2><p className="mt-0.5 text-[11px] text-muted-foreground">节点按顺序流转，审批人使用稳定账号主键解析，委托只影响新生成的节点任务。</p></div>
                      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!can("approval-workflow-config:edit")} onClick={() => setDraft({ ...draft, nodes: [...draft.nodes, createNode(draft.nodes.length)] })}><Plus className="size-3.5" />添加节点</Button>
                    </div>
                    <div className="overflow-x-auto rounded-md border border-border">
                      <div className="min-w-[980px]">
                        <div className="grid grid-cols-[44px_160px_130px_180px_100px_90px_100px_100px_84px] gap-2 bg-muted/55 px-3 py-2 text-[11px] font-semibold text-muted-foreground">
                          <span>顺序</span><span>节点名称</span><span>分配方式</span><span>审批对象</span><span>模式</span><span>通过人数</span><span>首次催办</span><span>重复间隔</span><span>操作</span>
                        </div>
                        {draft.nodes.map((node, index) => (
                          <div key={node.nodeKey} className="grid grid-cols-[44px_160px_130px_180px_100px_90px_100px_100px_84px] items-center gap-2 border-t border-border px-3 py-2">
                            <span className="text-center text-xs font-semibold">{index + 1}</span>
                            <Input value={node.nodeName} onChange={(event) => updateNode(index, { nodeName: event.target.value })} className="h-8 text-xs" />
                            <Select value={node.assignmentType} onChange={(event) => updateNode(index, { assignmentType: event.target.value as ApprovalWorkflowNodeInput["assignmentType"] })} className="h-8 text-xs">
                              <option value="PROJECT_ROLE">项目角色</option><option value="ACCOUNT">指定账号</option><option value="REQUESTER">发起人</option>
                            </Select>
                            {node.assignmentType === "PROJECT_ROLE" ? (
                              <Select value={node.projectRoleName || ""} onChange={(event) => updateNode(index, { projectRoleName: event.target.value })} className="h-8 text-xs">
                                <option value="">请选择角色</option>{roles.map((role) => <option key={role.id} value={role.roleName}>{role.roleName}</option>)}
                              </Select>
                            ) : node.assignmentType === "ACCOUNT" ? (
                              <Select value={node.accountId || ""} onChange={(event) => updateNode(index, { accountId: event.target.value })} className="h-8 text-xs">
                                <option value="">请选择账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName} · {account.username}</option>)}
                              </Select>
                            ) : <div className="px-2 text-xs text-muted-foreground">审批发起人</div>}
                            <Select value={node.approvalMode || "ALL"} onChange={(event) => updateNode(index, { approvalMode: event.target.value as "ALL" | "ANY" })} className="h-8 text-xs"><option value="ALL">会签</option><option value="ANY">或签</option></Select>
                            <div className="px-2 text-xs text-muted-foreground">{node.approvalMode === "ANY" ? "1 人" : "全部"}</div>
                            <Input type="number" min={1} value={node.reminderAfterHours || 24} onChange={(event) => updateNode(index, { reminderAfterHours: Number(event.target.value) || 24 })} className="h-8 text-xs" title="小时" />
                            <Input type="number" min={1} value={node.reminderIntervalHours || 24} onChange={(event) => updateNode(index, { reminderIntervalHours: Number(event.target.value) || 24 })} className="h-8 text-xs" title="小时" />
                            <div className="flex items-center gap-1">
                              <Button type="button" size="icon" variant="ghost" className="size-7" disabled={index === 0} title="上移" onClick={() => moveNode(index, -1)}><ArrowUp className="size-3.5" /></Button>
                              <Button type="button" size="icon" variant="ghost" className="size-7" disabled={index === draft.nodes.length - 1} title="下移" onClick={() => moveNode(index, 1)}><ArrowDown className="size-3.5" /></Button>
                              <Button type="button" size="icon" variant="ghost" className="size-7 text-destructive" disabled={draft.nodes.length <= 1} title="删除节点" onClick={() => setDraft({ ...draft, nodes: draft.nodes.filter((_, nodeIndex) => nodeIndex !== index).map((item, nodeIndex) => ({ ...item, nodeOrder: nodeIndex + 1 })) })}><Trash2 className="size-3.5" /></Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </section>

                  <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                    <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy || !can("approval-workflow-config:edit")} onClick={() => void saveDraft()}><Save className="size-3.5" />另存为草稿版本</Button>
                    <Button size="sm" className="h-8 text-xs" disabled={busy || selectedVersion.status !== "DRAFT" || !can("approval-workflow-config:publish")} onClick={() => void publishVersion()}><Send className="size-3.5" />发布当前草稿</Button>
                  </div>
                </CardContent>
              </>
            )}
          </Card>
        </div>
      )}

      {tab === "DELEGATION" && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-sm"><UsersRound className="size-4 text-primary" />审批委托</CardTitle><CardDescription className="text-xs">委托按账号主键和生效时间解析，只影响委托生效后新创建的审批节点。</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 border-y border-border py-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_180px_180px_1.4fr_auto]">
              <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">委托人</Label><Select value={delegationDraft.fromAccountId} onChange={(event) => setDelegationDraft({ ...delegationDraft, fromAccountId: event.target.value })} className="h-8 text-xs"><option value="">请选择</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</Select></div>
              <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">受托人</Label><Select value={delegationDraft.toAccountId} onChange={(event) => setDelegationDraft({ ...delegationDraft, toAccountId: event.target.value })} className="h-8 text-xs"><option value="">请选择</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</Select></div>
              <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">适用范围</Label><Select value={delegationDraft.projectId} onChange={(event) => setDelegationDraft({ ...delegationDraft, projectId: event.target.value })} className="h-8 text-xs"><option value="">全部项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.code || project.name} · {project.name}</option>)}</Select></div>
              <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">开始时间</Label><Input type="datetime-local" value={delegationDraft.startsAt} onChange={(event) => setDelegationDraft({ ...delegationDraft, startsAt: event.target.value })} className="h-8 text-xs" /></div>
              <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">结束时间</Label><Input type="datetime-local" value={delegationDraft.endsAt} onChange={(event) => setDelegationDraft({ ...delegationDraft, endsAt: event.target.value })} className="h-8 text-xs" /></div>
              <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">委托原因</Label><Input value={delegationDraft.reason} onChange={(event) => setDelegationDraft({ ...delegationDraft, reason: event.target.value })} className="h-8 text-xs" placeholder="出差、休假等" /></div>
              <div className="flex items-end"><Button size="sm" className="h-8 text-xs" disabled={busy || !can("approval-workflow-config:delegate")} onClick={() => void createDelegation()}><Plus className="size-3.5" />新增</Button></div>
            </div>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[900px] text-left text-xs">
                <thead className="bg-muted/55 text-muted-foreground"><tr><th className="px-3 py-2">委托关系</th><th className="px-3 py-2">适用范围</th><th className="px-3 py-2">生效时间</th><th className="px-3 py-2">原因</th><th className="px-3 py-2">状态</th><th className="px-3 py-2 text-right">操作</th></tr></thead>
                <tbody>{delegations.map((item) => <tr key={item.id} className="border-t border-border"><td className="px-3 py-2 font-medium">{item.fromDisplayName} → {item.toDisplayName}</td><td className="px-3 py-2 text-muted-foreground">{item.projectId ? projectNameById.get(item.projectId) || item.projectId : "全部项目"}</td><td className="px-3 py-2 text-muted-foreground">{new Date(item.startsAt).toLocaleString("zh-CN")} 至 {new Date(item.endsAt).toLocaleString("zh-CN")}</td><td className="max-w-[260px] truncate px-3 py-2" title={item.reason}>{item.reason || "--"}</td><td className="px-3 py-2"><Badge className={item.enabled ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-border bg-muted text-muted-foreground"}>{item.enabled ? "启用" : "停用"}</Badge></td><td className="px-3 py-2"><div className="flex justify-end gap-1"><Button size="sm" variant="ghost" className="h-7 text-[11px]" disabled={busy} onClick={() => void toggleDelegation(item)}>{item.enabled ? "停用" : "启用"}</Button><Button size="icon" variant="ghost" className="size-7 text-destructive" disabled={busy} onClick={() => void deleteDelegation(item)}><Trash2 className="size-3.5" /></Button></div></td></tr>)}</tbody>
              </table>
              {delegations.length === 0 && <div className="px-4 py-12 text-center text-xs text-muted-foreground">暂无审批委托</div>}
            </div>
          </CardContent>
        </Card>
      )}

      {tab === "ANALYTICS" && (
        <Card>
          <CardHeader className="pb-3"><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="flex items-center gap-2 text-sm"><BarChart3 className="size-4 text-primary" />审批运行统计</CardTitle><CardDescription className="text-xs">统计审批周期、逾期任务、当前节点和业务类型分布。</CardDescription></div><div className="flex gap-2"><Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy || !can("approval-workflow-config:remind")} onClick={() => void remindNow()}><AlarmClock className="size-3.5" />立即催办</Button><Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => void loadAnalytics()}><RefreshCw className="size-3.5" />刷新</Button></div></div></CardHeader>
          <CardContent className="space-y-5 border-t border-border pt-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {analyticsMetrics.map(({ label, value, icon: Icon }) => <div key={label} className="border-l-2 border-primary/35 bg-muted/20 px-3 py-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="size-3.5" />{label}</div><div className="mt-2 text-xl font-semibold">{value}</div></div>)}
            </div>
            <div className="grid gap-5 xl:grid-cols-2">
              <section><h2 className="mb-2 text-xs font-semibold">业务类型分布</h2><div className="overflow-hidden rounded-md border border-border">{Object.entries(analytics?.businessCounts ?? {}).map(([businessType, counts]) => <div key={businessType} className="grid grid-cols-[minmax(0,1fr)_repeat(3,80px)] border-b border-border px-3 py-2 text-xs last:border-b-0"><span className="font-medium">{APPROVAL_BUSINESS_TYPE_LABEL[businessType] ?? businessType}</span><span className="text-muted-foreground">审批中 {counts.PENDING ?? 0}</span><span className="text-muted-foreground">通过 {counts.APPROVED ?? 0}</span><span className="text-muted-foreground">退回 {Number(counts.REJECTED ?? 0) + Number(counts.RETURNED ?? 0)}</span></div>)}{Object.keys(analytics?.businessCounts ?? {}).length === 0 && <div className="px-3 py-8 text-center text-xs text-muted-foreground">暂无运行数据</div>}</div></section>
              <section><h2 className="mb-2 text-xs font-semibold">当前待处理节点</h2><div className="overflow-hidden rounded-md border border-border">{(analytics?.pendingNodes ?? []).map((item) => <div key={item.nodeName} className="flex items-center justify-between border-b border-border px-3 py-2 text-xs last:border-b-0"><span>{item.nodeName}</span><Badge variant="secondary">{item.count}</Badge></div>)}{(analytics?.pendingNodes ?? []).length === 0 && <div className="px-3 py-8 text-center text-xs text-muted-foreground">当前没有待处理节点</div>}</div></section>
            </div>
            <section><h2 className="mb-2 text-xs font-semibold">最近审批</h2><div className="overflow-x-auto rounded-md border border-border"><table className="w-full min-w-[820px] text-left text-xs"><thead className="bg-muted/55 text-muted-foreground"><tr><th className="px-3 py-2">审批</th><th className="px-3 py-2">项目</th><th className="px-3 py-2">发起人</th><th className="px-3 py-2">状态</th><th className="px-3 py-2">发起时间</th></tr></thead><tbody>{(analytics?.recent ?? []).map((item) => <tr key={item.id} className="border-t border-border"><td className="px-3 py-2 font-medium">{item.title}</td><td className="px-3 py-2 text-muted-foreground">{item.project.code} · {item.project.name}</td><td className="px-3 py-2">{item.requesterName}</td><td className="px-3 py-2">{APPROVAL_INSTANCE_STATUS_LABEL[item.status] ?? item.status}</td><td className="px-3 py-2 text-muted-foreground">{new Date(item.requestedAt).toLocaleString("zh-CN")}</td></tr>)}</tbody></table></div></section>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
