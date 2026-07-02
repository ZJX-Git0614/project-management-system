"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Upload, Search } from "lucide-react";
import { ItemHealth, ItemRiskStatus, ItemStatus, ItemPriority } from "@/domain/enums";
import {
  ITEM_STATUS_LABEL,
  ITEM_PRIORITY_LABEL,
  ITEM_HEALTH_LABEL,
  ITEM_RISK_STATUS_LABEL,
} from "@/lib/constants";
import { downloadTextFile, formatDateInput, toCsv, formatYearMonth, getWeekOfMonth, diffDays } from "@/lib/utils";
import { usePermission } from "@/lib/use-permission";
import { useConfirm } from "@/components/confirm-provider";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api-client";
import { useAuth } from "@/contexts/auth-context";
import { useCurrentProject } from "@/contexts/current-project-context";
import { useDraftedState } from "@/lib/use-drafted-state";

export type ItemKind = "monthly" | "weekly";

interface Project {
  id: string;
  name: string;
  code: string;
  status: string;
}

interface ItemRecord {
  id: string;
  projectId: string;
  title: string;
  description: string;
  dueDate: string;
  status: ItemStatus;
  owner: string;
  priority: ItemPriority;
  plannedStartDate: string;
  actualStartDate: string;
  plannedEndDate: string;
  actualEndDate: string;
  progress: number;
  health: ItemHealth;
  issueAndAction: string;
  dependency: string;
  risk: string;
  riskStatus: ItemRiskStatus;
  remark: string;
  createdAt: string;
  updatedAt: string;
  project?: {
    id: string;
    name: string;
    code: string;
    status: string;
  };
}

interface ItemPanelProps {
  kind: ItemKind;
  apiPath: string;
  title: string;
  description: string;
  dateRange: { start: string; end: string };
  csvFilename: string;
  csvHeaders: string[];
}

const STATUS_BADGE_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "destructive"> = {
  [ItemStatus.PENDING]: "secondary",
  [ItemStatus.IN_PROGRESS]: "warning",
  [ItemStatus.DONE]: "success",
  [ItemStatus.CANCELED]: "destructive",
};

const PRIORITY_BADGE_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "destructive"> = {
  [ItemPriority.LOW]: "secondary",
  [ItemPriority.NORMAL]: "default",
  [ItemPriority.HIGH]: "warning",
  [ItemPriority.URGENT]: "destructive",
};

const HEALTH_BADGE_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "destructive"> = {
  [ItemHealth.HEALTHY]: "success",
  [ItemHealth.AT_RISK]: "warning",
  [ItemHealth.OFF_TRACK]: "destructive",
  [ItemHealth.UNKNOWN]: "secondary",
};

const PROGRESS_BAR_COLOR = (p: number) => {
  if (p >= 100) return "bg-emerald-500";
  if (p >= 60) return "bg-sky-500";
  if (p >= 30) return "bg-amber-500";
  return "bg-rose-500";
};

const DATE_CELL = (s?: string) => (s && s.length >= 10 ? s.slice(5) : "-");

export const ItemPanel = ({
  kind,
  apiPath,
  title,
  description,
  dateRange,
  csvFilename,
  csvHeaders,
}: ItemPanelProps) => {
  const { can } = usePermission();
  const confirm = useConfirm();
  const { user } = useAuth();
  const { currentProject, currentProjectId } = useCurrentProject();
  const [items, setItems] = useState<ItemRecord[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [projectFilter, setProjectFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [healthFilter, setHealthFilter] = useState("ALL");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft, clearDraft] = useDraftedState<ItemRecord | null>(
    `pmms.draft.item.${kind}`,
    null
  );
  const [saving, setSaving] = useState(false);

  const canView = can(`${kind}-items:view`);
  const canCreate = can(`${kind}-items:create`);
  const canEdit = can(`${kind}-items:edit`);
  const canDelete = can(`${kind}-items:delete`);
  const canExport = can(`${kind}-items:export`);

  const fetchData = useCallback(async () => {
    if (!canView) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [itemList, projectList] = await Promise.all([
        api.get<ItemRecord[]>(`${apiPath}?startDate=${dateRange.start}&endDate=${dateRange.end}`),
        api.get<Project[]>("/api/projects"),
      ]);
      setItems(itemList);
      setProjects(projectList);
    } catch {
      // handled
    } finally {
      setLoading(false);
    }
  }, [canView, apiPath, dateRange.start, dateRange.end]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return items.filter((item) => {
      const hitKw = !kw || item.title.toLowerCase().includes(kw) || item.owner.toLowerCase().includes(kw);
      const hitProject = projectFilter === "ALL" || item.projectId === projectFilter;
      const hitStatus = statusFilter === "ALL" || item.status === statusFilter;
      const hitHealth = healthFilter === "ALL" || item.health === healthFilter;
      return hitKw && hitProject && hitStatus && hitHealth;
    });
  }, [items, keyword, projectFilter, statusFilter, healthFilter]);

  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        const dateA = a.plannedStartDate || a.dueDate;
        const dateB = b.plannedStartDate || b.dueDate;
        return dateA.localeCompare(dateB);
      }),
    [filtered]
  );

  const handleExport = () => {
    const rows = sorted.map((it) => {
      const p = projects.find((pp) => pp.id === it.projectId);
      const startDev = diffDays(it.plannedStartDate, it.actualStartDate);
      return [
        formatYearMonth(it.plannedStartDate || it.dueDate),
        it.priority === ItemPriority.HIGH || it.priority === ItemPriority.URGENT ? "是" : "否",
        `第${getWeekOfMonth(it.plannedStartDate || it.dueDate) || "-"}周`,
        it.title,
        p ? `${p.name}(${p.code})` : "-",
        it.owner,
        ITEM_PRIORITY_LABEL[it.priority as ItemPriority] ?? it.priority,
        it.plannedStartDate || "-",
        it.actualStartDate || "-",
        it.plannedEndDate || "-",
        it.actualEndDate || "-",
        startDev === null ? "-" : (startDev === 0 ? "0" : (startDev > 0 ? `+${startDev}` : `${startDev}`)),
        `${it.progress}%`,
        ITEM_STATUS_LABEL[it.status as ItemStatus] ?? it.status,
        ITEM_HEALTH_LABEL[it.health as ItemHealth] ?? it.health,
        it.issueAndAction || "-",
        it.dependency || "-",
        it.risk || "-",
        ITEM_RISK_STATUS_LABEL[it.riskStatus as ItemRiskStatus] ?? it.riskStatus,
        it.remark || "-",
      ];
    });
    const csv = toCsv(csvHeaders, rows);
    downloadTextFile(`${csvFilename}_${Date.now()}.csv`, csv);
  };

  const openCreate = () => {
    setEditingId(null);
    setDraft({
      id: "",
      projectId: currentProjectId ?? "",
      title: "",
      description: "",
      dueDate: "",
      status: ItemStatus.PENDING,
      owner: user?.displayName ?? "",
      priority: ItemPriority.NORMAL,
      plannedStartDate: "",
      actualStartDate: "",
      plannedEndDate: "",
      actualEndDate: "",
      progress: 0,
      health: ItemHealth.UNKNOWN,
      issueAndAction: "",
      dependency: "",
      risk: "",
      riskStatus: ItemRiskStatus.NONE,
      remark: "",
      createdAt: "",
      updatedAt: "",
      project: currentProject
        ? {
            id: currentProject.id,
            name: currentProject.name,
            code: currentProject.code,
            status: currentProject.status,
          }
        : undefined,
    });
  };

  const openEdit = (item: ItemRecord) => {
    setEditingId(item.id);
    setDraft({ ...item });
  };

  const cancelEdit = () => {
    setEditingId(null);
    clearDraft();
  };

  const updateDraft = <K extends keyof ItemRecord>(key: K, value: ItemRecord[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const submitCreate = async () => {
    if (!draft) return;
    if (!currentProjectId) {
      alert("请先从项目列表中选择当前项目");
      return;
    }
    if (!draft.title.trim() || !draft.dueDate || draft.progress < 0) {
      alert("请填写标题、截止日期，且进度 ≥ 0");
      return;
    }
    setSaving(true);
    try {
      const { id: _id, createdAt: _ca, updatedAt: _ua, project: _p, ...payload } = draft;
      void _id; void _ca; void _ua; void _p;
      await api.post(apiPath, payload);
      clearDraft();
      await fetchData();
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const submitEdit = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const { id: _id, createdAt: _ca, updatedAt: _ua, project: _p, ...payload } = draft;
      void _id; void _ca; void _ua; void _p;
      await api.put(`${apiPath}/${draft.id}`, payload);
      cancelEdit();
      await fetchData();
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item: ItemRecord) => {
    if (!(await confirm(`确认删除事项「${item.title}」？`))) return;
    try {
      await api.delete(`${apiPath}/${item.id}`);
      await fetchData();
    } catch (err) {
      alert(err instanceof Error ? err.message : "删除失败");
    }
  };

  if (!canView) {
    return (
      <Card className="border-warning/30 bg-warning/5">
        <CardContent className="py-4 text-sm">当前角色无权查看{title}。</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">{title}</CardTitle>
              <CardDescription className="text-xs">
                {description} · 时间窗口 {dateRange.start} ~ {dateRange.end}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          <div className="flex-1 min-w-[160px]">
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
              <Search className="mr-1 inline size-3" /> 标题/负责人
            </label>
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="请输入关键词"
              className="h-8 text-xs"
            />
          </div>
          <div className="w-[180px]">
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">项目</label>
            <Select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="h-8 text-xs"
            >
              <option value="ALL">全部项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </div>
          <div className="w-[120px]">
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">状态</label>
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-8 text-xs"
            >
              <option value="ALL">全部</option>
              {Object.values(ItemStatus).map((s) => (
                <option key={s} value={s}>{ITEM_STATUS_LABEL[s]}</option>
              ))}
            </Select>
          </div>
          <div className="w-[120px]">
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">健康</label>
            <Select
              value={healthFilter}
              onChange={(e) => setHealthFilter(e.target.value)}
              className="h-8 text-xs"
            >
              <option value="ALL">全部</option>
              {Object.values(ItemHealth).map((s) => (
                <option key={s} value={s}>{ITEM_HEALTH_LABEL[s]}</option>
              ))}
            </Select>
          </div>
          <div className="flex gap-2">
            {canExport && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={handleExport}
                disabled={sorted.length === 0}
              >
                <Upload className="size-3" /> 导出
              </Button>
            )}
            {canCreate && (
              <Button
                size="sm"
                className="h-8 text-xs"
                onClick={openCreate}
                disabled={!currentProjectId}
                title={!currentProjectId ? "请先到「项目列表」选择当前项目" : undefined}
              >
                <Plus className="size-3" /> 新增
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">月份</TableHead>
                  <TableHead className="whitespace-nowrap">周重点事件</TableHead>
                  <TableHead className="whitespace-nowrap">周</TableHead>
                  <TableHead className="whitespace-nowrap min-w-[200px]">事项</TableHead>
                  <TableHead className="whitespace-nowrap min-w-[160px]">归属方</TableHead>
                  <TableHead className="whitespace-nowrap">责任人</TableHead>
                  <TableHead className="whitespace-nowrap">优先级</TableHead>
                  <TableHead className="whitespace-nowrap">计划<br/>开始时间</TableHead>
                  <TableHead className="whitespace-nowrap">实际<br/>开始时间</TableHead>
                  <TableHead className="whitespace-nowrap">计划<br/>结束时间</TableHead>
                  <TableHead className="whitespace-nowrap">实际<br/>结束时间</TableHead>
                  <TableHead className="whitespace-nowrap">任务偏差</TableHead>
                  <TableHead className="whitespace-nowrap min-w-[90px]">进度</TableHead>
                  <TableHead className="whitespace-nowrap">状态</TableHead>
                  <TableHead className="whitespace-nowrap min-w-[140px]">健康</TableHead>
                  <TableHead className="whitespace-nowrap min-w-[120px]">当前问题/措施</TableHead>
                  <TableHead className="whitespace-nowrap min-w-[120px]">依赖条件</TableHead>
                  <TableHead className="whitespace-nowrap">风险</TableHead>
                  <TableHead className="whitespace-nowrap min-w-[120px] sticky right-0 bg-card">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((item) => {
                  const monthAnchor = item.plannedStartDate || item.dueDate;
                  const startDev = diffDays(item.plannedStartDate, item.actualStartDate);
                  const endDev = diffDays(item.plannedEndDate, item.actualEndDate);
                  const showDev = startDev !== null || endDev !== null;
                  const devText = (n: number | null) =>
                    n === null ? null : n === 0 ? "0" : n > 0 ? `+${n}天` : `${n}天`;
                  return (
                    <TableRow key={item.id} className="h-8 align-top">
                      <TableCell className="text-xs">{formatYearMonth(monthAnchor)}</TableCell>
                      <TableCell className="text-xs">
                        {item.priority === ItemPriority.HIGH || item.priority === ItemPriority.URGENT ? "是" : "否"}
                      </TableCell>
                      <TableCell className="text-xs">第{getWeekOfMonth(monthAnchor) || "-"}周</TableCell>
                      <TableCell>
                        <div className="font-medium text-xs leading-tight">{item.title}</div>
                        {item.description && (
                          <div className="text-[10px] text-muted-foreground line-clamp-1">{item.description}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {item.project ? (
                          <>
                            <div className="font-medium">{item.project.name}</div>
                            <div className="text-[10px] text-muted-foreground">{item.project.code}</div>
                          </>
                        ) : "-"}
                      </TableCell>
                      <TableCell className="text-xs">{item.owner}</TableCell>
                      <TableCell>
                        <Badge variant={PRIORITY_BADGE_VARIANT[item.priority] ?? "default"}>
                          {ITEM_PRIORITY_LABEL[item.priority as ItemPriority] ?? item.priority}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{DATE_CELL(item.plannedStartDate)}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{DATE_CELL(item.actualStartDate)}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{DATE_CELL(item.plannedEndDate)}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{DATE_CELL(item.actualEndDate)}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        {showDev ? (
                          <div className="flex flex-col leading-tight">
                            <span>起:{devText(startDev) ?? "-"}</span>
                            <span>止:{devText(endDev) ?? "-"}</span>
                          </div>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                            <div
                              className={`h-full ${PROGRESS_BAR_COLOR(item.progress)}`}
                              style={{ width: `${Math.min(100, Math.max(0, item.progress))}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground tabular-nums">{item.progress}%</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_BADGE_VARIANT[item.status] ?? "default"}>
                          {ITEM_STATUS_LABEL[item.status as ItemStatus] ?? item.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={HEALTH_BADGE_VARIANT[item.health] ?? "default"}>
                          {ITEM_HEALTH_LABEL[item.health as ItemHealth] ?? item.health}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs whitespace-pre-wrap break-words max-w-[200px]">
                        {item.issueAndAction || "-"}
                      </TableCell>
                      <TableCell className="text-xs whitespace-pre-wrap break-words max-w-[160px]">
                        {item.dependency || "-"}
                      </TableCell>
                      <TableCell className="text-xs whitespace-pre-wrap break-words max-w-[160px]">
                        {item.risk || "-"}
                      </TableCell>
                      <TableCell className="sticky right-0 bg-card">
                        <div className="flex items-center gap-1">
                          {canEdit && (
                            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => openEdit(item)}>
                              编辑
                            </Button>
                          )}
                          {canDelete && (
                            <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive" onClick={() => handleDelete(item)}>
                              删除
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {sorted.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={20} className="h-32 text-center text-sm text-muted-foreground">
                      {items.length === 0
                        ? `时间窗口内暂无${title}。${
                            canCreate
                              ? currentProjectId
                                ? "点击右上角「新增」开始记录。"
                                : "请先到「项目列表」选择当前项目后再新增。"
                              : ""
                          }`
                        : "无匹配事项"}
                    </TableCell>
                  </TableRow>
                )}
                {loading && (
                  <TableRow>
                    <TableCell colSpan={20} className="h-24 text-center text-sm text-muted-foreground">
                      加载中...
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {draft && editingId === null && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">新增事项</CardTitle>
          </CardHeader>
          <CardContent className="p-3">
            <div className="grid grid-cols-2 gap-3">
              <FormField label="所属项目" required>
                {currentProject ? (
                  <div className="flex h-8 items-center rounded-md border border-input bg-muted/40 px-2 text-xs">
                    <span className="font-medium">{currentProject.name}</span>
                    <span className="ml-1.5 text-muted-foreground">{currentProject.code}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">已绑定当前项目</span>
                  </div>
                ) : (
                  <div className="flex h-8 items-center rounded-md border border-destructive/40 bg-destructive/5 px-2 text-xs text-destructive">
                    请先到「项目列表」选择当前项目
                  </div>
                )}
              </FormField>
              <FormField label="负责人" required>
                <Input value={draft.owner} onChange={(e) => updateDraft("owner", e.target.value)} className="h-8 text-xs" required />
              </FormField>
            </div>
            <FormField label="事项标题" required>
              <Input value={draft.title} onChange={(e: ChangeEvent<HTMLInputElement>) => updateDraft("title", e.target.value)} className="h-8 text-xs" required />
            </FormField>
            <FormField label="事项描述">
              <Textarea value={draft.description} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateDraft("description", e.target.value)} className="text-xs min-h-[60px]" />
            </FormField>
            <div className="grid grid-cols-4 gap-3">
              <FormField label="计划开始">
                <Input type="date" value={formatDateInput(draft.plannedStartDate)} onChange={(e) => updateDraft("plannedStartDate", e.target.value)} className="h-8 text-xs" />
              </FormField>
              <FormField label="实际开始">
                <Input type="date" value={formatDateInput(draft.actualStartDate)} onChange={(e) => updateDraft("actualStartDate", e.target.value)} className="h-8 text-xs" />
              </FormField>
              <FormField label="计划结束">
                <Input type="date" value={formatDateInput(draft.plannedEndDate)} onChange={(e) => updateDraft("plannedEndDate", e.target.value)} className="h-8 text-xs" />
              </FormField>
              <FormField label="实际结束">
                <Input type="date" value={formatDateInput(draft.actualEndDate)} onChange={(e) => updateDraft("actualEndDate", e.target.value)} className="h-8 text-xs" />
              </FormField>
            </div>
            <FormField label="截止日期" required>
              <Input type="date" value={formatDateInput(draft.dueDate)} onChange={(e) => updateDraft("dueDate", e.target.value)} className="h-8 text-xs" required />
            </FormField>
            <div className="grid grid-cols-4 gap-3">
              <FormField label="优先级">
                <select
                  value={draft.priority}
                  onChange={(e) => updateDraft("priority", e.target.value as ItemPriority)}
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  {Object.values(ItemPriority).map((p) => (
                    <option key={p} value={p}>{ITEM_PRIORITY_LABEL[p]}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="状态">
                <select
                  value={draft.status}
                  onChange={(e) => updateDraft("status", e.target.value as ItemStatus)}
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  {Object.values(ItemStatus).map((s) => (
                    <option key={s} value={s}>{ITEM_STATUS_LABEL[s]}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="健康状态">
                <select
                  value={draft.health}
                  onChange={(e) => updateDraft("health", e.target.value as ItemHealth)}
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  {Object.values(ItemHealth).map((s) => (
                    <option key={s} value={s}>{ITEM_HEALTH_LABEL[s]}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="风险状态">
                <select
                  value={draft.riskStatus}
                  onChange={(e) => updateDraft("riskStatus", e.target.value as ItemRiskStatus)}
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  {Object.values(ItemRiskStatus).map((s) => (
                    <option key={s} value={s}>{ITEM_RISK_STATUS_LABEL[s]}</option>
                  ))}
                </select>
              </FormField>
            </div>
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <FormField label={`进度（${draft.progress}%）`}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={draft.progress}
                  onChange={(e) => updateDraft("progress", Number.parseInt(e.target.value, 10))}
                  className="block h-8 w-full"
                />
              </FormField>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => updateDraft("health",
                  draft.progress >= 100 ? ItemHealth.HEALTHY :
                  draft.progress >= 60 ? (itemRiskLevel(draft.progress) === "high" ? ItemHealth.AT_RISK : ItemHealth.HEALTHY) :
                  draft.progress >= 30 ? ItemHealth.AT_RISK :
                  ItemHealth.OFF_TRACK
                )}
              >
                自动评估健康
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="当前问题/措施">
                <Textarea value={draft.issueAndAction} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateDraft("issueAndAction", e.target.value)} className="text-xs min-h-[50px]" />
              </FormField>
              <FormField label="依赖条件">
                <Textarea value={draft.dependency} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateDraft("dependency", e.target.value)} className="text-xs min-h-[50px]" />
              </FormField>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="风险描述">
                <Textarea value={draft.risk} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateDraft("risk", e.target.value)} className="text-xs min-h-[50px]" />
              </FormField>
              <FormField label="备注">
                <Textarea value={draft.remark} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateDraft("remark", e.target.value)} className="text-xs min-h-[50px]" />
              </FormField>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={cancelEdit}>
                取消
              </Button>
              <Button type="button" size="sm" className="h-7 text-xs" disabled={saving} onClick={submitCreate}>
                {saving ? "保存中..." : "保存"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {draft && editingId !== null && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">编辑事项</CardTitle>
          </CardHeader>
          <CardContent className="p-3">
            <div className="grid grid-cols-2 gap-3">
              <FormField label="所属项目" required>
                <Input value={draft.project?.name ?? draft.projectId} disabled className="h-8 text-xs" />
              </FormField>
              <FormField label="负责人" required>
                <Input value={draft.owner} onChange={(e) => updateDraft("owner", e.target.value)} className="h-8 text-xs" required />
              </FormField>
            </div>
            <FormField label="事项标题" required>
              <Input value={draft.title} onChange={(e: ChangeEvent<HTMLInputElement>) => updateDraft("title", e.target.value)} className="h-8 text-xs" required />
            </FormField>
            <FormField label="事项描述">
              <Textarea value={draft.description} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateDraft("description", e.target.value)} className="text-xs min-h-[60px]" />
            </FormField>
            <div className="grid grid-cols-4 gap-3">
              <FormField label="计划开始">
                <Input type="date" value={formatDateInput(draft.plannedStartDate)} onChange={(e) => updateDraft("plannedStartDate", e.target.value)} className="h-8 text-xs" />
              </FormField>
              <FormField label="实际开始">
                <Input type="date" value={formatDateInput(draft.actualStartDate)} onChange={(e) => updateDraft("actualStartDate", e.target.value)} className="h-8 text-xs" />
              </FormField>
              <FormField label="计划结束">
                <Input type="date" value={formatDateInput(draft.plannedEndDate)} onChange={(e) => updateDraft("plannedEndDate", e.target.value)} className="h-8 text-xs" />
              </FormField>
              <FormField label="实际结束">
                <Input type="date" value={formatDateInput(draft.actualEndDate)} onChange={(e) => updateDraft("actualEndDate", e.target.value)} className="h-8 text-xs" />
              </FormField>
            </div>
            <FormField label="截止日期" required>
              <Input type="date" value={formatDateInput(draft.dueDate)} onChange={(e) => updateDraft("dueDate", e.target.value)} className="h-8 text-xs" required />
            </FormField>
            <div className="grid grid-cols-4 gap-3">
              <FormField label="优先级">
                <select
                  value={draft.priority}
                  onChange={(e) => updateDraft("priority", e.target.value as ItemPriority)}
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  {Object.values(ItemPriority).map((p) => (
                    <option key={p} value={p}>{ITEM_PRIORITY_LABEL[p]}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="状态">
                <select
                  value={draft.status}
                  onChange={(e) => updateDraft("status", e.target.value as ItemStatus)}
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  {Object.values(ItemStatus).map((s) => (
                    <option key={s} value={s}>{ITEM_STATUS_LABEL[s]}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="健康状态">
                <select
                  value={draft.health}
                  onChange={(e) => updateDraft("health", e.target.value as ItemHealth)}
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  {Object.values(ItemHealth).map((s) => (
                    <option key={s} value={s}>{ITEM_HEALTH_LABEL[s]}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="风险状态">
                <select
                  value={draft.riskStatus}
                  onChange={(e) => updateDraft("riskStatus", e.target.value as ItemRiskStatus)}
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  {Object.values(ItemRiskStatus).map((s) => (
                    <option key={s} value={s}>{ITEM_RISK_STATUS_LABEL[s]}</option>
                  ))}
                </select>
              </FormField>
            </div>
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <FormField label={`进度（${draft.progress}%）`}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={draft.progress}
                  onChange={(e) => updateDraft("progress", Number.parseInt(e.target.value, 10))}
                  className="block h-8 w-full"
                />
              </FormField>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => updateDraft("health",
                  draft.progress >= 100 ? ItemHealth.HEALTHY :
                  draft.progress >= 60 ? (itemRiskLevel(draft.progress) === "high" ? ItemHealth.AT_RISK : ItemHealth.HEALTHY) :
                  draft.progress >= 30 ? ItemHealth.AT_RISK :
                  ItemHealth.OFF_TRACK
                )}
              >
                自动评估健康
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="当前问题/措施">
                <Textarea value={draft.issueAndAction} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateDraft("issueAndAction", e.target.value)} className="text-xs min-h-[50px]" />
              </FormField>
              <FormField label="依赖条件">
                <Textarea value={draft.dependency} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateDraft("dependency", e.target.value)} className="text-xs min-h-[50px]" />
              </FormField>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="风险描述">
                <Textarea value={draft.risk} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateDraft("risk", e.target.value)} className="text-xs min-h-[50px]" />
              </FormField>
              <FormField label="备注">
                <Textarea value={draft.remark} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateDraft("remark", e.target.value)} className="text-xs min-h-[50px]" />
              </FormField>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={cancelEdit}>
                取消
              </Button>
              <Button type="button" size="sm" className="h-7 text-xs" disabled={saving} onClick={submitEdit}>
                {saving ? "保存中..." : "保存"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

const itemRiskLevel = (progress: number): "low" | "high" =>
  progress >= 70 ? "low" : "high";

const FormField = ({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) => (
  <div className="space-y-1">
    <label className="text-[11px] font-medium text-muted-foreground">
      {label}
      {required && <span className="text-destructive ml-0.5">*</span>}
    </label>
    {children}
  </div>
);
