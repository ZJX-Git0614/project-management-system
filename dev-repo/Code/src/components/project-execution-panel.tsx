"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Boxes, CircleAlert, Link2, Pencil, Plus, Search, ShieldCheck, Trash2, X } from "lucide-react";

import type { ProjectExecution, ProjectGanttTask, ProjectMember } from "@/domain/models";
import type { ProjectStatus } from "@/domain/enums";
import { api } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ModalDialog } from "@/components/modal-dialog";

type ExecutionForm = {
  id: string | null;
  name: string;
  type: string;
  status: string;
  ownerMemberId: string;
  description: string;
  taskIds: string[];
};

type ExecutionCockpit = {
  summary: { stageCount: number; offTrackCount: number; atRiskCount: number; currentStageId: string | null };
  stages: Array<ProjectExecution & {
    health: { status: "HEALTHY" | "AT_RISK" | "OFF_TRACK" | "UNKNOWN"; label: string; evidence: Array<{ message: string }> };
    latestGate: { status: string; approvalInstanceId: string } | null;
    related: { matters?: { openCount: number; overdueCount: number }; risks?: { openHighRiskCount: number } };
  }>;
  alerts: Array<{ stageId: string; stageName: string; health: string; message: string; severity: string }>;
};

const EMPTY_FORM: ExecutionForm = {
  id: null,
  name: "",
  type: "SHORT_TERM",
  status: "PLANNED",
  ownerMemberId: "",
  description: "",
  taskIds: [],
};

const TYPE_LABELS: Record<string, string> = {
  SHORT_TERM: "短期执行阶段",
  WORK_PACKAGE: "工作包",
  MILESTONE: "里程碑",
  RELEASE: "版本 / 交付",
};

const STATUS_LABELS: Record<string, string> = {
  PLANNED: "计划中",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  ARCHIVED: "已归档",
};

const formatScheduleValue = (value?: string) => value || "--";

const formatProgress = (value?: number) => `${Math.max(0, Math.min(100, value ?? 0))}%`;

const taskLabel = (task: Pick<ProjectGanttTask, "taskCode" | "taskName">) => (
  `${task.taskCode || "未编号"} · ${task.taskName || "未命名任务"}`
);

export function ProjectExecutionPanel({
  projectId,
  projectStatus,
}: {
  projectId: string;
  projectStatus: ProjectStatus;
}) {
  const { can } = usePermission();
  const canCreate = can("project-gantt:create");
  const canEdit = can("project-gantt:edit");
  const canDelete = can("project-gantt:delete");
  const canRequestGate = can("project-execution:gate-request");
  const readOnly = projectStatus === "COMPLETED" || projectStatus === "VOIDED";
  const [executions, setExecutions] = useState<ProjectExecution[]>([]);
  const [cockpit, setCockpit] = useState<ExecutionCockpit | null>(null);
  const [tasks, setTasks] = useState<ProjectGanttTask[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState<ExecutionForm>(EMPTY_FORM);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [taskSearch, setTaskSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [initializing, setInitializing] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [cockpitData, executionData, taskData, memberData] = await Promise.all([
        api.get<ExecutionCockpit>(`/api/projects/${projectId}/execution-cockpit`),
        api.get<ProjectExecution[]>(`/api/projects/${projectId}/executions`),
        api.get<ProjectGanttTask[]>(`/api/projects/${projectId}/gantt-tasks?refresh=${Date.now()}`),
        api.get<ProjectMember[]>(`/api/projects/${projectId}/members`),
      ]);
      setCockpit(cockpitData);
      setExecutions(executionData);
      setTasks(taskData);
      setMembers(memberData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "执行阶段加载失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const filteredTasks = useMemo(() => {
    const keyword = taskSearch.trim().toLocaleLowerCase();
    if (!keyword) return tasks;
    return tasks.filter((task) => `${task.taskCode} ${task.taskName} ${task.taskCategory}`.toLocaleLowerCase().includes(keyword));
  }, [taskSearch, tasks]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setTaskSearch("");
    setDialogOpen(true);
  };

  const openEdit = (execution: ProjectExecution) => {
    setForm({
      id: execution.id,
      name: execution.name,
      type: execution.type,
      status: execution.status,
      ownerMemberId: execution.ownerMemberId ?? "",
      description: execution.description,
      taskIds: execution.taskLinks.map((link) => link.ganttTaskId),
    });
    setTaskSearch("");
    setDialogOpen(true);
  };

  const toggleTask = (taskId: string) => {
    setForm((current) => ({
      ...current,
      taskIds: current.taskIds.includes(taskId)
        ? current.taskIds.filter((id) => id !== taskId)
        : [...current.taskIds, taskId],
    }));
  };

  const save = async () => {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      const payload = {
        name: form.name.trim(),
        type: form.type,
        status: form.status,
        ownerMemberId: form.ownerMemberId || null,
        description: form.description.trim(),
        taskIds: form.taskIds,
        scopeLinks: form.taskIds.map((ganttTaskId) => ({ ganttTaskId, relationType: "DIRECT" })),
      };
      if (form.id) {
        await api.put(`/api/projects/${projectId}/executions/${form.id}`, payload);
      } else {
        await api.post(`/api/projects/${projectId}/executions`, payload);
      }
      setDialogOpen(false);
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (execution: ProjectExecution) => {
    if (!window.confirm(`确认删除执行阶段“${execution.name}”？关联的 WBS 任务不会被删除。`)) return;
    try {
      await api.delete(`/api/projects/${projectId}/executions/${execution.id}`);
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
    }
  };

  const requestGate = async (execution: ProjectExecution) => {
    const note = window.prompt(`为阶段“${execution.name}”填写出口 Gate 放行说明：`);
    if (!note?.trim()) return;
    try {
      await api.post(`/api/projects/${projectId}/executions/${execution.id}/gate`, { requestNote: note.trim() });
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Gate 放行申请失败");
    }
  };

  const initializeFromWbs = async () => {
    if (!window.confirm("将按每个一级 WBS 创建一个执行阶段，并自动包含其全部子任务。不会修改 WBS 计划。是否继续？")) return;
    setInitializing(true);
    setError("");
    try {
      await api.post(`/api/projects/${projectId}/executions/initialize-from-wbs`, {});
      await loadData();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "按 WBS 初始化阶段失败");
    } finally {
      setInitializing(false);
    }
  };

  return (
    <div className="space-y-4">
      {cockpit ? (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">执行阶段</div><div className="mt-1 text-2xl font-semibold tabular-nums">{cockpit.summary.stageCount}</div></CardContent></Card>
            <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">当前阶段</div><div className="mt-1 truncate text-sm font-semibold">{cockpit.stages.find((stage) => stage.id === cockpit.summary.currentStageId)?.name ?? "暂无"}</div></CardContent></Card>
            <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">需要关注</div><div className="mt-1 text-2xl font-semibold tabular-nums text-amber-600">{cockpit.summary.atRiskCount}</div></CardContent></Card>
            <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">已偏离</div><div className="mt-1 text-2xl font-semibold tabular-nums text-destructive">{cockpit.summary.offTrackCount}</div></CardContent></Card>
          </div>
          {cockpit.alerts.length > 0 ? <Card><CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><CircleAlert className="size-4 text-amber-600" />待处理预警</CardTitle></CardHeader><CardContent className="space-y-2">{cockpit.alerts.slice(0, 6).map((alert) => <div key={`${alert.stageId}:${alert.message}`} className="flex gap-2 text-sm"><AlertTriangle className={cn("mt-0.5 size-4 shrink-0", alert.severity === "HIGH" ? "text-destructive" : "text-amber-600")} /><span><strong>{alert.stageName}</strong>：{alert.message}</span></div>)}</CardContent></Card> : null}
        </>
      ) : null}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2"><Boxes className="size-5 text-primary" />项目执行驾驶舱</CardTitle>
            <CardDescription>
              阶段只汇总 WBS 范围、事项和风险；出口 Gate 满足条件并审批通过后才放行完成。
            </CardDescription>
          </div>
          <Button size="sm" onClick={openCreate} disabled={!canCreate || readOnly}>
            <Plus className="size-4" />新增阶段
          </Button>
        </CardHeader>
        <CardContent>
          {error ? <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
          {loading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">加载执行阶段...</div>
          ) : executions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
              <Boxes className="mx-auto mb-3 size-8 text-muted-foreground" />
              <div className="text-sm font-medium text-foreground">暂无执行阶段</div>
              <div className="mt-1 text-xs text-muted-foreground">可按一级 WBS 自动生成阶段范围，或手工创建跨分支工作包。</div>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void initializeFromWbs()} disabled={!canCreate || readOnly || initializing}>
                  {initializing ? "初始化中..." : "按一级 WBS 生成阶段"}
                </Button>
                <Button size="sm" onClick={openCreate} disabled={!canCreate || readOnly}>手工新增阶段</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {executions.map((execution) => (
                <div key={execution.id} className="rounded-lg border border-border/80 bg-background/30 p-4 transition-colors hover:border-primary/35">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-foreground">{execution.name}</h3>
                        <Badge variant="secondary">{TYPE_LABELS[execution.type] ?? execution.type}</Badge>
                        <Badge variant={execution.status === "IN_PROGRESS" ? "default" : "outline"}>
                          {STATUS_LABELS[execution.status] ?? execution.status}
                        </Badge>
                        {(() => {
                          const stage = cockpit?.stages.find((item) => item.id === execution.id);
                          const health = stage?.health;
                          return health ? <Badge variant={health.status === "OFF_TRACK" ? "destructive" : health.status === "AT_RISK" ? "secondary" : "outline"}>{health.label}</Badge> : null;
                        })()}
                      </div>
                      {execution.description ? <p className="mt-1 text-sm text-muted-foreground">{execution.description}</p> : null}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {execution.status !== "COMPLETED" ? <Button variant="ghost" size="icon" aria-label="申请出口 Gate 放行" title="申请出口 Gate 放行" onClick={() => void requestGate(execution)} disabled={!canRequestGate || readOnly}>
                        <ShieldCheck className="size-4" />
                      </Button> : null}
                      <Button variant="ghost" size="icon" aria-label="编辑执行阶段" title="编辑执行阶段" onClick={() => openEdit(execution)} disabled={!canEdit || readOnly || execution.status === "COMPLETED"}>
                        <Pencil className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon" aria-label="删除执行阶段" title="删除执行阶段" onClick={() => void remove(execution)} disabled={!canDelete || readOnly}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 text-sm md:grid-cols-4">
                    <div><div className="text-xs text-muted-foreground">负责人</div><div className="mt-1 truncate">{execution.ownerMember?.personName ?? "未指定"}</div></div>
                    <div><div className="text-xs text-muted-foreground">计划范围</div><div className="mt-1">{formatScheduleValue(execution.planStart)} - {formatScheduleValue(execution.planFinish)}</div></div>
                    <div><div className="text-xs text-muted-foreground">有效末级任务</div><div className="mt-1">{execution.scope?.completedTaskCount ?? 0}/{execution.scope?.totalTaskCount ?? execution.taskLinks.length} 项完成</div></div>
                    <div><div className="text-xs text-muted-foreground">加权进度</div><div className="mt-1">{formatProgress(execution.progress)}</div></div>
                  </div>
                  {(() => {
                    const stage = cockpit?.stages.find((item) => item.id === execution.id);
                    if (!stage) return null;
                    return <div className="mt-3 flex flex-wrap gap-2 border-t border-border/70 pt-3 text-xs text-muted-foreground">
                      <span>Gate：{stage.latestGate?.status === "APPROVED" ? "已放行" : stage.latestGate?.status === "PENDING_APPROVAL" ? "审批中" : "待评估"}</span>
                      {stage.related.matters ? <span>未完成事项：{stage.related.matters.openCount}</span> : null}
                      {stage.related.risks ? <span>未关闭高风险：{stage.related.risks.openHighRiskCount}</span> : null}
                      {stage.health.evidence.slice(0, 2).map((evidence) => <span key={evidence.message} className="text-amber-700">{evidence.message}</span>)}
                    </div>;
                  })()}
                  <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/70 pt-3">
                    {execution.taskLinks.length === 0 ? (
                      <span className="text-xs text-muted-foreground">尚未关联 WBS 任务</span>
                    ) : execution.taskLinks.map((link) => (
                      <span key={link.ganttTaskId} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 py-1 text-xs text-muted-foreground" title={link.task ? taskLabel(link.task) : link.ganttTaskId}>
                        <Link2 className="size-3 shrink-0" />
                        <span className="truncate">{link.task ? taskLabel(link.task) : link.ganttTaskId}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ModalDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={form.id ? "编辑执行阶段" : "新增执行阶段"}
        size="lg"
        footer={(
          <>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={() => void save()} disabled={saving || !form.name.trim() || (form.id ? !canEdit : !canCreate) || readOnly}>
              {saving ? "保存中..." : "保存"}
            </Button>
          </>
        )}
      >
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1.5 text-sm"><span className="text-muted-foreground">阶段名称</span><Input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：样机联调" autoFocus /></label>
            <label className="space-y-1.5 text-sm"><span className="text-muted-foreground">类型</span><Select value={form.type} onChange={(event) => setForm((current) => ({ ...current, type: event.target.value }))}>
              {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select></label>
            <label className="space-y-1.5 text-sm"><span className="text-muted-foreground">状态</span><Select value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value }))}>
              {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select></label>
            <label className="space-y-1.5 text-sm"><span className="text-muted-foreground">阶段负责人</span><Select value={form.ownerMemberId} onChange={(event) => setForm((current) => ({ ...current, ownerMemberId: event.target.value }))}>
              <option value="">未指定</option>
              {members.map((member) => <option key={member.id} value={member.id}>{member.personName} · {member.roleName}</option>)}
            </Select></label>
          </div>
          <label className="block space-y-1.5 text-sm"><span className="text-muted-foreground">说明</span><textarea className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition focus:border-primary/60" value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="可选" /></label>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2"><div className="text-sm font-medium">关联 WBS 任务 <span className="text-xs font-normal text-muted-foreground">({form.taskIds.length} 项)</span></div><div className="relative w-full sm:w-64"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input className="pl-8" value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)} placeholder="搜索任务编号或名称" /><button type="button" className={cn("absolute right-1 top-1 grid size-7 place-items-center text-muted-foreground", !taskSearch && "hidden")} onClick={() => setTaskSearch("")} aria-label="清除任务搜索"><X className="size-4" /></button></div></div>
            <div className="max-h-72 overflow-auto rounded-md border border-border/80">
              {filteredTasks.length === 0 ? <div className="px-3 py-8 text-center text-sm text-muted-foreground">没有匹配的 WBS 任务</div> : filteredTasks.map((task) => (
                <label key={task.id} className="flex cursor-pointer items-center gap-3 border-b border-border/60 px-3 py-2.5 last:border-b-0 hover:bg-accent/30">
                  <input type="checkbox" checked={form.taskIds.includes(task.id)} onChange={() => toggleTask(task.id)} className="size-4 accent-primary" />
                  <span className="min-w-0 truncate text-sm" title={taskLabel(task)}>{taskLabel(task)}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </ModalDialog>
    </div>
  );
}
