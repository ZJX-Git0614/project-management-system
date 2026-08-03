"use client";

import { KeyboardEvent, type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/confirm-provider";
import { usePermission } from "@/lib/use-permission";
import { useCurrentProject } from "@/contexts/current-project-context";
import { api } from "@/lib/api-client";
import { TableContextMenu, useTableContextMenu } from "@/components/table-context-menu";
import { HierarchicalMultiSelect, type HierarchicalSelectOption } from "@/components/hierarchical-multi-select";

type RiskLevel = "高" | "中" | "低";
type RiskStatus = "识别中" | "跟踪中" | "处理中" | "已关闭";
type DropPosition = "before" | "after";
type EditableRiskField =
  | "riskName"
  | "weeklyItemId"
  | "category"
  | "trigger"
  | "probability"
  | "impact"
  | "level"
  | "response"
  | "owner"
  | "status"
  | "targetDate";

interface RiskRegisterItem {
  id: string;
  sortOrder?: number;
  riskCode: string;
  riskName: string;
  weeklyItemId?: string | null;
  linkedItemCode: string;
  linkedItemName: string;
  category: string;
  trigger: string;
  probability: string;
  impact: string;
  level: string;
  response: string;
  owner: string;
  status: string;
  targetDate: string;
}

interface ProjectItemOption {
  id: string;
  matterCode: string;
  title: string;
}

const riskLevelOptions: RiskLevel[] = ["高", "中", "低"];
const riskStatusOptions: RiskStatus[] = ["识别中", "跟踪中", "处理中", "已关闭"];

const inlineInputClass = "h-7 min-w-0 rounded border-border bg-background px-2 text-xs";
const inlineSelectClass = "h-7 min-w-[96px] px-2 text-xs";
const inlineTextareaClass = "min-h-14 min-w-[180px] resize-y rounded border-border bg-background px-2 py-1 text-xs";

export default function RiskRegisterPage() {
  const { can } = usePermission();
  const confirm = useConfirm();
  const { currentProjectId } = useCurrentProject();
  const [riskItems, setRiskItems] = useState<RiskRegisterItem[]>([]);
  const [itemOptions, setItemOptions] = useState<ProjectItemOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingCell, setEditingCell] = useState<{ id: string; field: EditableRiskField } | null>(null);
  const [editValue, setEditValue] = useState("");
  const editValueRef = useRef("");
  const [draft, setDraft] = useState<RiskRegisterItem | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [draggedRiskId, setDraggedRiskId] = useState<string | null>(null);
  const [riskDropTarget, setRiskDropTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  const [reordering, setReordering] = useState(false);
  const { menu, openContextMenu, closeContextMenu } = useTableContextMenu();

  const canCreate = can("risk-register:create");
  const canEdit = can("risk-register:edit");
  const canDelete = can("risk-register:delete");

  const fetchData = useCallback(async () => {
    if (!currentProjectId) {
      setRiskItems([]);
      setLoading(false);
      return;
    }
    try {
      const data = await api.get<RiskRegisterItem[]>(`/api/projects/${currentProjectId}/risk-register`);
      setRiskItems(Array.isArray(data) ? data : []);
    } catch {
      setRiskItems([]);
    } finally {
      setLoading(false);
    }
  }, [currentProjectId]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  useEffect(() => {
    if (!currentProjectId) { setItemOptions([]); return; }
    api.get<ProjectItemOption[]>(`/api/weekly-items?projectId=${encodeURIComponent(currentProjectId)}`)
      .then((items) => setItemOptions(items.filter((item) => item.title.trim())))
      .catch(() => setItemOptions([]));
  }, [currentProjectId]);

  const itemSelectOptions = useMemo<HierarchicalSelectOption[]>(
    () => itemOptions.map((item) => ({
      id: item.id,
      label: item.matterCode || "未编号事项",
      secondaryLabel: item.title,
    })),
    [itemOptions],
  );

  // ---- 编辑态管理 ----
  const closeEdit = () => { setEditingCell(null); setEditValue(""); editValueRef.current = ""; };

  const isEditing = (id: string, field: EditableRiskField) =>
    editingCell?.id === id && editingCell.field === field;

  const openTextEdit = (item: RiskRegisterItem, field: EditableRiskField) => {
    if (!canEdit) return;
    const v = String(item[field] ?? "");
    setEditingCell({ id: item.id, field });
    setEditValue(v);
    editValueRef.current = v;
  };

  const setEdit = (v: string) => { setEditValue(v); editValueRef.current = v; };

  // 文本字段提交
  const commitTextChange = async (id: string, field: EditableRiskField) => {
    if (!currentProjectId) return;
    const value = editValueRef.current;
    try {
      await api.put(`/api/projects/${currentProjectId}/risk-register/${id}`, { [field]: value });
      setRiskItems((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
      closeEdit();
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存失败");
    }
  };

  // 下拉字段提交（选中即保存）
  const commitSelectChange = async (id: string, field: EditableRiskField, value: string) => {
    if (!currentProjectId) return;
    try {
      const updated = await api.put<RiskRegisterItem>(`/api/projects/${currentProjectId}/risk-register/${id}`, { [field]: value });
      setRiskItems((prev) => prev.map((r) => (r.id === id ? updated : r)));
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存失败");
    }
  };

  const handleEditKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Escape") { e.preventDefault(); closeEdit(); return; }
    if (e.key !== "Enter") return;
    if (e.currentTarget instanceof HTMLTextAreaElement && e.shiftKey) return;
    e.preventDefault();
    if (editingCell) commitTextChange(editingCell.id, editingCell.field);
  };

  // ---- 新建 ----
  const openCreate = () => {
    setDraft({
      id: "", sortOrder: 0, riskCode: "", riskName: "", weeklyItemId: null, linkedItemCode: "", linkedItemName: "", category: "", trigger: "",
      probability: "中", impact: "中", level: "中", response: "", owner: "",
      status: "识别中", targetDate: "",
    });
  };

  const updateDraft = (field: EditableRiskField, value: string) => {
    setDraft((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  const submitCreate = async () => {
    if (!draft || !currentProjectId) return;
    if (!draft.riskName.trim() || !draft.owner.trim()) { alert("请填写风险名称和责任人"); return; }
    try {
      const created = await api.post<RiskRegisterItem>(`/api/projects/${currentProjectId}/risk-register`, draft);
      setRiskItems((prev) => [...prev, created]);
      setDraft(null);
    } catch (error) {
      alert(error instanceof Error ? error.message : "创建失败");
    }
  };

  // ---- 批量删除 ----
  const toggleSelectionMode = () => { setSelectionMode((prev) => !prev); setSelectedIds([]); };
  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };
  const deleteSelected = async () => {
    if (selectedIds.length === 0 || !currentProjectId) return;
    if (!(await confirm(`确认删除选中的 ${selectedIds.length} 条风险？`))) return;
    try {
      await Promise.all(selectedIds.map((id) => api.delete(`/api/projects/${currentProjectId}/risk-register/${id}`)));
      setRiskItems((prev) => prev.filter((r) => !selectedIds.includes(r.id)));
      setSelectedIds([]); setSelectionMode(false);
    } catch (error) {
      alert(error instanceof Error ? error.message : "删除失败");
    }
  };

  const deleteRisk = async (item: RiskRegisterItem) => {
    if (!currentProjectId || !(await confirm(`确认删除「${item.riskName}」？`))) return;
    try {
      await api.delete(`/api/projects/${currentProjectId}/risk-register/${item.id}`);
      setRiskItems((prev) => prev.filter((risk) => risk.id !== item.id));
      setSelectedIds((prev) => prev.filter((id) => id !== item.id));
    } catch (error) {
      alert(error instanceof Error ? error.message : "删除失败");
    }
  };

  const riskContextActions = (item?: RiskRegisterItem) => [
    ...(item && canEdit
      ? [{ label: "编辑风险", icon: <Pencil className="size-3.5" />, onSelect: () => openTextEdit(item, "riskName") }]
      : []),
    ...(item && canDelete
      ? [{
          label: selectionMode && selectedIds.includes(item.id) ? "取消选择此风险" : "选择此风险",
          onSelect: () => {
            if (!selectionMode) setSelectionMode(true);
            toggleSelected(item.id);
          },
        }]
      : []),
    ...(item && canDelete
      ? [{ label: "删除此风险", icon: <Trash2 className="size-3.5" />, destructive: true, onSelect: () => deleteRisk(item) }]
      : []),
    ...(!item && canCreate && currentProjectId
      ? [{ label: "新增风险", icon: <Plus className="size-3.5" />, onSelect: openCreate }]
      : []),
    ...(!item && canDelete && selectedIds.length > 0
      ? [{ label: `删除已选择 ${selectedIds.length} 条风险`, icon: <Trash2 className="size-3.5" />, destructive: true, onSelect: deleteSelected }]
      : []),
  ];

  const getDropPosition = (event: DragEvent<HTMLElement>): DropPosition => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };

  const reorderRisks = async (targetRiskId: string, position: DropPosition) => {
    if (!currentProjectId || !draggedRiskId || draggedRiskId === targetRiskId || reordering) return;
    const riskIds = riskItems.map((item) => item.id);
    const fromIndex = riskIds.indexOf(draggedRiskId);
    const toIndex = riskIds.indexOf(targetRiskId);
    if (fromIndex < 0 || toIndex < 0) return;

    const nextRiskIds = [...riskIds];
    const [movedRiskId] = nextRiskIds.splice(fromIndex, 1);
    const targetIndexAfterRemoval = nextRiskIds.indexOf(targetRiskId);
    nextRiskIds.splice(position === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval, 0, movedRiskId);

    setReordering(true);
    setRiskItems((prev) => {
      const itemById = new Map(prev.map((item) => [item.id, item]));
      return nextRiskIds.map((id, index) => ({
        ...itemById.get(id)!,
        sortOrder: index + 1,
        riskCode: `Risk${String(index + 1).padStart(3, "0")}`,
      }));
    });

    try {
      await api.post(`/api/projects/${currentProjectId}/risk-register/reorder`, { riskIds: nextRiskIds });
      await fetchData();
    } catch (error) {
      alert(error instanceof Error ? error.message : "排序保存失败");
      await fetchData();
    } finally {
      setReordering(false);
      setDraggedRiskId(null);
      setRiskDropTarget(null);
    }
  };

  // ---- 渲染 ----
  if (!can("risk-register:view")) {
    return <Card className="border-warning/30 bg-warning/5"><CardContent className="py-4 text-sm">当前角色无权查看风险登记册。</CardContent></Card>;
  }
  if (loading) {
    return <Card><CardContent className="py-4 text-sm text-muted-foreground">加载中…</CardContent></Card>;
  }

  const renderTextCell = (item: RiskRegisterItem, field: EditableRiskField, display: string, inputClass: string, placeholder?: string) => {
    if (isEditing(item.id, field)) {
      return (
        <Input
          value={editValue}
          onChange={(e) => setEdit(e.target.value)}
          onKeyDown={handleEditKeyDown}
          onBlur={() => commitTextChange(item.id, field)}
          className={inputClass}
          placeholder={placeholder}
          autoFocus
        />
      );
    }
    return (
      <div
        className={canEdit ? "cursor-pointer rounded px-1 py-0.5 hover:bg-primary/5" : ""}
        onClick={() => openTextEdit(item, field)}
      >
        {display}
      </div>
    );
  };

  const renderTextareaCell = (item: RiskRegisterItem, field: EditableRiskField, display: string, placeholder?: string) => {
    if (isEditing(item.id, field)) {
      return (
        <Textarea
          value={editValue}
          onChange={(e) => setEdit(e.target.value)}
          onKeyDown={handleEditKeyDown}
          onBlur={() => commitTextChange(item.id, field)}
          className={inlineTextareaClass}
          placeholder={placeholder}
          autoFocus
        />
      );
    }
    return (
      <div
        className={canEdit ? "cursor-pointer rounded px-1 py-0.5 text-muted-foreground hover:bg-primary/5" : "text-muted-foreground"}
        onClick={() => openTextEdit(item, field)}
      >
        {display}
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">风险登记册</CardTitle>
          <div className="flex items-center gap-2">
            {canDelete && (
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={toggleSelectionMode}>
                {selectionMode ? "取消选择" : "选择"}
              </Button>
            )}
            {reordering && <span className="text-xs text-muted-foreground">排序保存中...</span>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table onContextMenu={(event) => openContextMenu(event, riskContextActions())}>
          <TableHeader>
            <TableRow>
              {selectionMode && <TableHead className="w-[48px] whitespace-nowrap">选择</TableHead>}
              <TableHead className="w-[64px] whitespace-nowrap">序号</TableHead>
              <TableHead className="min-w-[96px] whitespace-nowrap">风险ID</TableHead>
              <TableHead className="min-w-[180px] whitespace-nowrap">风险名称</TableHead>
              <TableHead className="min-w-[220px] whitespace-nowrap">关联项目事项</TableHead>
              <TableHead className="whitespace-nowrap">类别</TableHead>
              <TableHead className="min-w-[180px] whitespace-nowrap">触发条件</TableHead>
              <TableHead className="whitespace-nowrap">概率</TableHead>
              <TableHead className="whitespace-nowrap">影响</TableHead>
              <TableHead className="whitespace-nowrap">等级</TableHead>
              <TableHead className="min-w-[240px] whitespace-nowrap">应对措施</TableHead>
              <TableHead className="whitespace-nowrap">责任人</TableHead>
              <TableHead className="whitespace-nowrap">状态</TableHead>
              <TableHead className="whitespace-nowrap">计划关闭日期</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* ---- 新建行 ---- */}
            {draft && (
              <TableRow className="align-top bg-primary/5">
                {selectionMode && <TableCell />}
                <TableCell className="text-xs text-muted-foreground">-</TableCell>
                <TableCell className="whitespace-nowrap font-mono text-[11px] font-semibold text-muted-foreground">保存后生成</TableCell>
                <TableCell><Input value={draft.riskName} onChange={(e) => updateDraft("riskName", e.target.value)} className={`${inlineInputClass} min-w-[160px]`} placeholder="风险名称" autoFocus /></TableCell>
                <TableCell>
                  <HierarchicalMultiSelect
                    options={itemSelectOptions}
                    value={draft.weeklyItemId ? [draft.weeklyItemId] : []}
                    onChange={(ids) => updateDraft("weeklyItemId", ids[0] ?? "")}
                    multiple={false}
                    placeholder="不关联"
                    searchPlaceholder="搜索事项 ID 或名称"
                    ariaLabel="关联项目事项"
                    className={`${inlineSelectClass} min-w-[220px]`}
                  />
                </TableCell>
                <TableCell><Input value={draft.category} onChange={(e) => updateDraft("category", e.target.value)} className={`${inlineInputClass} w-[96px]`} placeholder="类别" /></TableCell>
                <TableCell><Textarea value={draft.trigger} onChange={(e) => updateDraft("trigger", e.target.value)} className={inlineTextareaClass} placeholder="触发条件" /></TableCell>
                <TableCell><Select value={draft.probability} onChange={(e) => updateDraft("probability", e.target.value)} className={inlineSelectClass}>{riskLevelOptions.map((o) => (<option key={o} value={o}>{o}</option>))}</Select></TableCell>
                <TableCell><Select value={draft.impact} onChange={(e) => updateDraft("impact", e.target.value)} className={inlineSelectClass}>{riskLevelOptions.map((o) => (<option key={o} value={o}>{o}</option>))}</Select></TableCell>
                <TableCell><Select value={draft.level} onChange={(e) => updateDraft("level", e.target.value)} className={inlineSelectClass}>{riskLevelOptions.map((o) => (<option key={o} value={o}>{o}</option>))}</Select></TableCell>
                <TableCell><Textarea value={draft.response} onChange={(e) => updateDraft("response", e.target.value)} className={inlineTextareaClass} placeholder="应对措施" /></TableCell>
                <TableCell><Input value={draft.owner} onChange={(e) => updateDraft("owner", e.target.value)} className={`${inlineInputClass} w-[96px]`} placeholder="责任人" /></TableCell>
                <TableCell><Select value={draft.status} onChange={(e) => updateDraft("status", e.target.value)} className={inlineSelectClass}>{riskStatusOptions.map((o) => (<option key={o} value={o}>{o}</option>))}</Select></TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Input type="date" value={draft.targetDate} onChange={(e) => updateDraft("targetDate", e.target.value)} className={`${inlineInputClass} w-[122px]`} />
                    <Button size="sm" className="h-7 text-xs" onClick={() => void submitCreate()}>保存</Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setDraft(null)}>取消</Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
            {/* ---- 数据行 ---- */}
            {riskItems.map((item, index) => (
              <TableRow
                key={item.id}
                draggable={canEdit && !selectionMode && editingCell?.id !== item.id}
                onDragStart={(event) => {
                  if (!canEdit || selectionMode || editingCell?.id === item.id) return;
                  setDraggedRiskId(item.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", item.id);
                }}
                onDragOver={(event) => {
                  if (!draggedRiskId || draggedRiskId === item.id) return;
                  event.preventDefault();
                  setRiskDropTarget({ id: item.id, position: getDropPosition(event) });
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  void reorderRisks(item.id, riskDropTarget?.id === item.id ? riskDropTarget.position : "before");
                }}
                onDragEnd={() => {
                  setDraggedRiskId(null);
                  setRiskDropTarget(null);
                }}
                onContextMenu={(event) => openContextMenu(event, riskContextActions(item))}
                className={
                  editingCell?.id === item.id
                    ? "align-top bg-primary/5"
                    : [
                        "cursor-grab align-top transition-[background,box-shadow,transform] duration-150 active:cursor-grabbing",
                        index % 2 === 0 ? "bg-background" : "bg-muted/20",
                        "hover:bg-primary/5",
                        draggedRiskId === item.id ? "scale-[0.995] opacity-45 shadow-lg" : "",
                        riskDropTarget?.id === item.id && draggedRiskId !== item.id && riskDropTarget.position === "before"
                          ? "translate-y-1 bg-primary/10 shadow-[inset_0_6px_0_hsl(var(--primary)/0.16),inset_0_2px_0_hsl(var(--primary))]"
                          : "",
                        riskDropTarget?.id === item.id && draggedRiskId !== item.id && riskDropTarget.position === "after"
                          ? "-translate-y-1 bg-primary/10 shadow-[inset_0_-6px_0_hsl(var(--primary)/0.16),inset_0_-2px_0_hsl(var(--primary))]"
                          : "",
                      ].filter(Boolean).join(" ")
                }
              >
                {selectionMode && (
                  <TableCell>
                    <input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => toggleSelected(item.id)} onClick={(e) => e.stopPropagation()} className="h-3.5 w-3.5 rounded border-border bg-background" />
                  </TableCell>
                )}
                <TableCell className="text-xs tabular-nums text-muted-foreground">{index + 1}</TableCell>
                <TableCell className="whitespace-nowrap font-mono text-[11px] font-semibold text-muted-foreground">{item.riskCode || `Risk${String(index + 1).padStart(3, "0")}`}</TableCell>
                <TableCell>{renderTextCell(item, "riskName", item.riskName, `${inlineInputClass} min-w-[160px]`, "风险名称")}</TableCell>
                <TableCell>
                  <HierarchicalMultiSelect
                    options={itemSelectOptions}
                    value={item.weeklyItemId ? [item.weeklyItemId] : []}
                    onChange={(ids) => void commitSelectChange(item.id, "weeklyItemId", ids[0] ?? "")}
                    multiple={false}
                    placeholder="不关联"
                    searchPlaceholder="搜索事项 ID 或名称"
                    ariaLabel="关联项目事项"
                    className={`${inlineSelectClass} min-w-[220px]`}
                    disabled={!canEdit}
                  />
                </TableCell>
                <TableCell>{renderTextCell(item, "category", item.category, `${inlineInputClass} w-[96px]`, "类别")}</TableCell>
                <TableCell>{renderTextareaCell(item, "trigger", item.trigger, "触发条件")}</TableCell>
                <TableCell><Select variant="ghost" value={item.probability} onChange={(e) => commitSelectChange(item.id, "probability", e.target.value)} className={`${inlineSelectClass} w-[68px]`}>{riskLevelOptions.map((o) => (<option key={o} value={o}>{o}</option>))}</Select></TableCell>
                <TableCell><Select variant="ghost" value={item.impact} onChange={(e) => commitSelectChange(item.id, "impact", e.target.value)} className={`${inlineSelectClass} w-[68px]`}>{riskLevelOptions.map((o) => (<option key={o} value={o}>{o}</option>))}</Select></TableCell>
                <TableCell><Select variant="ghost" value={item.level} onChange={(e) => commitSelectChange(item.id, "level", e.target.value)} className={`${inlineSelectClass} w-[68px]`}>{riskLevelOptions.map((o) => (<option key={o} value={o}>{o}</option>))}</Select></TableCell>
                <TableCell>{renderTextareaCell(item, "response", item.response, "应对措施")}</TableCell>
                <TableCell>{renderTextCell(item, "owner", item.owner, `${inlineInputClass} w-[96px]`, "责任人")}</TableCell>
                <TableCell><Select variant="ghost" value={item.status} onChange={(e) => commitSelectChange(item.id, "status", e.target.value)} className={`${inlineSelectClass} w-[90px]`}>{riskStatusOptions.map((o) => (<option key={o} value={o}>{o}</option>))}</Select></TableCell>
                <TableCell>{renderTextCell(item, "targetDate", item.targetDate, `${inlineInputClass} w-[122px]`)}</TableCell>
              </TableRow>
            ))}
            {!loading && riskItems.length === 0 && (
              <TableRow>
                <TableCell colSpan={selectionMode ? 14 : 13} className="text-center text-muted-foreground text-xs py-8">
                  暂无风险条目{currentProjectId ? "，在表格中右击即可新增" : "，请先在项目列表中选择一个项目"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <TableContextMenu menu={menu} onClose={closeContextMenu} />
      </CardContent>
    </Card>
  );
}
