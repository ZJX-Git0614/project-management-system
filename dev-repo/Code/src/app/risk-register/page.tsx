"use client";

import { KeyboardEvent, type DragEvent, type FocusEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardPaste, Copy, Eye, Plus, Redo2, Scissors, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableActionButton,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirm } from "@/components/confirm-provider";
import { usePermission } from "@/lib/use-permission";
import { useCurrentProject } from "@/contexts/current-project-context";
import { api } from "@/lib/api-client";
import { TableContextMenu, type TableContextMenuAction, useTableContextMenu } from "@/components/table-context-menu";
import { HierarchicalMultiSelect, type HierarchicalSelectOption } from "@/components/hierarchical-multi-select";
import { cn } from "@/lib/utils";
import { useModuleHistory } from "@/lib/use-module-history";
import { useCommitOnOutsidePointer } from "@/lib/use-commit-on-outside-pointer";

type RiskLevel = "高" | "中" | "低";
type RiskStatus = "识别中" | "跟踪中" | "处理中" | "已关闭";
type DropPosition = "before" | "after";
type EditableRiskField =
  | "riskName"
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
  weeklyItemIds: string[];
  linkedItemCode: string;
  linkedItemName: string;
  linkedItems: Array<{ id: string; matterCode: string; title: string; sortOrder: number }>;
  affectedTasks: Array<{ id: string; taskCode: string; taskName: string; parentId?: string | null; sortOrder: number }>;
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
  linkedTasks?: Array<{ id: string; taskCode: string; taskName: string; parentId?: string | null; sortOrder: number }>;
}

interface ProjectGanttTaskOption {
  id: string;
  taskCode: string;
  taskName: string;
  parentId?: string | null;
  sortOrder: number;
}

const normalizeRisk = (risk: RiskRegisterItem): RiskRegisterItem => ({
  ...risk,
  weeklyItemIds: risk.weeklyItemIds?.length > 0
    ? risk.weeklyItemIds
    : risk.weeklyItemId ? [risk.weeklyItemId] : [],
  linkedItems: risk.linkedItems ?? [],
  affectedTasks: risk.affectedTasks ?? [],
});

const RiskDetailField = ({ label, value, wide = false }: { label: string; value?: string; wide?: boolean }) => (
  <div className={cn("min-w-0 border-b border-border/60 py-2.5", wide && "md:col-span-2")}>
    <div className="text-[11px] text-muted-foreground">{label}</div>
    <div className="mt-1 whitespace-pre-wrap break-words text-sm">{value || "-"}</div>
  </div>
);

interface RiskClipboard {
  projectId: string;
  mode: "COPY" | "MOVE";
  riskIds: string[];
}

interface RiskStructureResult {
  createdRiskIds: string[];
  movedRiskIds: string[];
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
  const [taskOptions, setTaskOptions] = useState<ProjectGanttTaskOption[]>([]);
  const [selectedRisk, setSelectedRisk] = useState<RiskRegisterItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingCell, setEditingCell] = useState<{ id: string; field: EditableRiskField } | null>(null);
  const [editValue, setEditValue] = useState("");
  const editValueRef = useRef("");
  const submittingRef = useRef(false);
  const [draft, setDraft] = useState<RiskRegisterItem | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<RiskClipboard | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [draggedRiskId, setDraggedRiskId] = useState<string | null>(null);
  const [riskDropTarget, setRiskDropTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  const [reordering, setReordering] = useState(false);
  const activeEditRowRef = useRef<HTMLTableRowElement>(null);
  const { menu, openContextMenu, closeContextMenu } = useTableContextMenu();

  const canCreate = can("risk-register:create");
  const canEdit = can("risk-register:edit");
  const canDelete = can("risk-register:delete");

  const fetchData = useCallback(async () => {
    if (!currentProjectId) {
      setRiskItems([]);
      setLoading(false);
      return [] as RiskRegisterItem[];
    }
    try {
      const data = await api.get<RiskRegisterItem[]>(`/api/projects/${currentProjectId}/risk-register`);
      const items = Array.isArray(data) ? data.map(normalizeRisk) : [];
      setRiskItems(items);
      return items;
    } catch {
      setRiskItems([]);
      return [] as RiskRegisterItem[];
    } finally {
      setLoading(false);
    }
  }, [currentProjectId]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  useEffect(() => {
    setClipboard(null);
  }, [currentProjectId]);

  const {
    undo,
    redo,
    runWithHistory,
    undoEntry,
    redoEntry,
    historyBusy,
  } = useModuleHistory({
    projectId: currentProjectId ?? "",
    module: "RISK_REGISTER",
    enabled: Boolean(currentProjectId),
    onRestored: async (targetIds) => {
      setEditingCell(null);
      setEditValue("");
      editValueRef.current = "";
      setDraft(null);
      setSelectedIds(targetIds);
      setSelectionAnchorId(targetIds.at(-1) ?? null);
      await fetchData();
    },
    onError: (errorTitle, message) => alert(`${errorTitle}\n${message}`),
    onWarning: (message) => alert(message),
  });

  useEffect(() => {
    if (!currentProjectId) {
      setItemOptions([]);
      setTaskOptions([]);
      return;
    }
    Promise.all([
      api.get<ProjectItemOption[]>(`/api/weekly-items?projectId=${encodeURIComponent(currentProjectId)}`),
      api.get<ProjectGanttTaskOption[]>(`/api/projects/${currentProjectId}/gantt-tasks`),
    ])
      .then(([items, tasks]) => {
        setItemOptions(items.filter((item) => item.title.trim()));
        setTaskOptions(tasks);
      })
      .catch(() => {
        setItemOptions([]);
        setTaskOptions([]);
      });
  }, [currentProjectId]);

  const itemSelectOptions = useMemo<HierarchicalSelectOption[]>(() => {
    const taskById = new Map(taskOptions.map((task) => [task.id, task]));
    const includedTaskIds = new Set<string>();
    itemOptions.forEach((item) => {
      item.linkedTasks?.forEach((task) => {
        let taskId: string | null | undefined = task.id;
        const seen = new Set<string>();
        while (taskId && !seen.has(taskId)) {
          seen.add(taskId);
          includedTaskIds.add(taskId);
          taskId = taskById.get(taskId)?.parentId;
        }
      });
    });
    const groupOptions: HierarchicalSelectOption[] = taskOptions
      .filter((task) => includedTaskIds.has(task.id))
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((task) => ({
        id: `wbs-group:${task.id}`,
        label: task.taskCode || "未编号任务",
        secondaryLabel: task.taskName,
        parentId: task.parentId && includedTaskIds.has(task.parentId) ? `wbs-group:${task.parentId}` : null,
        disabled: true,
      }));
    const matterOptions = itemOptions.map((item) => {
      const firstLinkedTask = [...(item.linkedTasks ?? [])]
        .sort((left, right) => left.sortOrder - right.sortOrder)[0];
      return {
        id: item.id,
        label: item.matterCode || "未编号事项",
        secondaryLabel: item.title,
        parentId: firstLinkedTask && includedTaskIds.has(firstLinkedTask.id)
          ? `wbs-group:${firstLinkedTask.id}`
          : null,
        searchText: `${item.matterCode} ${item.title} ${(item.linkedTasks ?? []).map((task) => `${task.taskCode} ${task.taskName}`).join(" ")}`,
      };
    });
    return [...groupOptions, ...matterOptions];
  }, [itemOptions, taskOptions]);

  // ---- 编辑态管理 ----
  const closeEdit = () => { setEditingCell(null); setEditValue(""); editValueRef.current = ""; setValidationErrors([]); };

  const isEditing = (id: string, field: EditableRiskField) =>
    editingCell?.id === id && editingCell.field === field;

  const openTextEdit = (item: RiskRegisterItem, field: EditableRiskField) => {
    if (!canEdit) return;
    const v = String(item[field] ?? "");
    setEditingCell({ id: item.id, field });
    setValidationErrors([]);
    setEditValue(v);
    editValueRef.current = v;
  };

  const setEdit = (v: string) => { setEditValue(v); editValueRef.current = v; };

  // 文本字段提交
  const commitTextChange = async (id: string, field: EditableRiskField) => {
    if (!currentProjectId || submittingRef.current) return;
    const value = editValueRef.current;
    if ((field === "riskName" || field === "owner") && !value.trim()) {
      setValidationErrors([field]);
      return;
    }
    submittingRef.current = true;
    try {
      const item = riskItems.find((risk) => risk.id === id);
      await runWithHistory(`修改风险「${item?.riskName || id}」`, [id], () => (
        api.put(`/api/projects/${currentProjectId}/risk-register/${id}`, { [field]: value })
      ));
      setRiskItems((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
      closeEdit();
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      submittingRef.current = false;
    }
  };

  // 下拉字段提交（选中即保存）
  const commitSelectChange = async <K extends keyof RiskRegisterItem>(id: string, field: K, value: RiskRegisterItem[K]) => {
    if (!currentProjectId) return;
    try {
      const item = riskItems.find((risk) => risk.id === id);
      const updated = await runWithHistory(`修改风险「${item?.riskName || id}」`, [id], () => (
        api.put<RiskRegisterItem>(`/api/projects/${currentProjectId}/risk-register/${id}`, { [field]: value })
      ));
      setRiskItems((prev) => prev.map((r) => (r.id === id ? normalizeRisk(updated) : r)));
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存失败");
    }
  };

  const handleEditKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Escape") { e.preventDefault(); closeEdit(); return; }
    if (e.key !== "Enter") return;
    if (e.currentTarget instanceof HTMLTextAreaElement && e.shiftKey) return;
    e.preventDefault();
    e.currentTarget.blur();
  };

  const handleCreateKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setDraft(null);
      setValidationErrors([]);
      return;
    }
    if (event.key !== "Enter") return;
    if (event.target instanceof HTMLTextAreaElement && event.shiftKey) return;
    event.preventDefault();
    if (event.target instanceof HTMLElement) event.target.blur();
  };

  const handleCreateBlur = (event: FocusEvent<HTMLElement>) => {
    const nextElement = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
    if (nextElement && (event.currentTarget.contains(nextElement) || nextElement.closest('[data-slot="dropdown-menu-content"]'))) return;
    void submitCreate();
  };

  // ---- 新建 ----
  const openCreate = () => {
    setValidationErrors([]);
    setDraft({
      id: "", sortOrder: 0, riskCode: "", riskName: "", weeklyItemId: null, weeklyItemIds: [], linkedItemCode: "", linkedItemName: "", linkedItems: [], affectedTasks: [], category: "", trigger: "",
      probability: "中", impact: "中", level: "中", response: "", owner: "",
      status: "识别中", targetDate: "",
    });
  };

  const updateDraft = <K extends keyof RiskRegisterItem>(field: K, value: RiskRegisterItem[K]) => {
    setValidationErrors((prev) => prev.filter((name) => name !== field));
    setDraft((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  const submitCreate = async () => {
    if (!draft || !currentProjectId || submittingRef.current) return;
    const errors = [!draft.riskName.trim() ? "riskName" : "", !draft.owner.trim() ? "owner" : ""].filter(Boolean);
    setValidationErrors(errors);
    if (errors.length > 0) return;
    submittingRef.current = true;
    try {
      const targetIds: string[] = [];
      await runWithHistory(`新增风险「${draft.riskName.trim()}」`, targetIds, async () => {
        const created = normalizeRisk(await api.post<RiskRegisterItem>(`/api/projects/${currentProjectId}/risk-register`, draft));
        targetIds.push(created.id);
        setRiskItems((prev) => [...prev, created]);
        setDraft(null);
      });
    } catch (error) {
      alert(error instanceof Error ? error.message : "创建失败");
    } finally {
      submittingRef.current = false;
    }
  };

  useCommitOnOutsidePointer(Boolean(draft || editingCell), activeEditRowRef, () => {
    if (draft) return submitCreate();
    if (editingCell) return commitTextChange(editingCell.id, editingCell.field);
  });

  const selectFromSequence = (itemId: string, event: MouseEvent<HTMLElement>) => {
    const itemIndex = riskItems.findIndex((item) => item.id === itemId);
    if (itemIndex < 0) return;
    if (event.shiftKey && selectionAnchorId) {
      const anchorIndex = riskItems.findIndex((item) => item.id === selectionAnchorId);
      if (anchorIndex >= 0) {
        const [start, end] = [anchorIndex, itemIndex].sort((a, b) => a - b);
        const rangeIds = riskItems.slice(start, end + 1).map((item) => item.id);
        setSelectedIds((prev) => event.metaKey || event.ctrlKey ? [...new Set([...prev, ...rangeIds])] : rangeIds);
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      setSelectedIds((prev) => prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]);
    } else {
      setSelectedIds([itemId]);
    }
    setSelectionAnchorId(itemId);
  };

  const riskDeleteMessage = (items: RiskRegisterItem[]) => {
    const linkedItems = [...new Map(items.flatMap((item) => (
      item.linkedItems?.length > 0
        ? item.linkedItems.map((linkedItem) => [linkedItem.id, `${linkedItem.matterCode} · ${linkedItem.title}`] as const)
        : item.weeklyItemId ? [[item.weeklyItemId, `${item.linkedItemCode} · ${item.linkedItemName}`] as const] : []
    ))).values()];
    const target = items.length === 1 ? `风险「${items[0].riskName}」` : `选中的 ${items.length} 条风险`;
    if (linkedItems.length === 0) return `确认删除${target}？`;
    return `确认删除${target}？\n当前关联以下项目事项：${linkedItems.join("、")}\n删除后关联关系将移除；撤销删除可恢复关联。`;
  };

  const deleteSelected = async (ids: string[] = selectedIds) => {
    if (ids.length === 0 || !currentProjectId) return;
    const targets = riskItems.filter((risk) => ids.includes(risk.id));
    if (!(await confirm(riskDeleteMessage(targets)))) return;
    try {
      await runWithHistory(`删除 ${targets.length} 条风险`, ids, async () => {
        await Promise.all(ids.map((id) => api.delete(`/api/projects/${currentProjectId}/risk-register/${id}`)));
      });
      setRiskItems((prev) => prev.filter((r) => !ids.includes(r.id)));
      setSelectedIds([]);
      setSelectionAnchorId(null);
    } catch (error) {
      alert(error instanceof Error ? error.message : "删除失败");
    }
  };

  const deleteRisk = async (item: RiskRegisterItem) => {
    if (!currentProjectId || !(await confirm(riskDeleteMessage([item])))) return;
    try {
      await runWithHistory(`删除风险「${item.riskName}」`, [item.id], () => (
        api.delete(`/api/projects/${currentProjectId}/risk-register/${item.id}`)
      ));
      setRiskItems((prev) => prev.filter((risk) => risk.id !== item.id));
      setSelectedIds((prev) => prev.filter((id) => id !== item.id));
    } catch (error) {
      alert(error instanceof Error ? error.message : "删除失败");
    }
  };

  const copyOrCutRisks = useCallback((mode: RiskClipboard["mode"], ids: string[]) => {
    if (!currentProjectId || ids.length === 0) return;
    const orderedIds = riskItems.filter((risk) => ids.includes(risk.id)).map((risk) => risk.id);
    setClipboard({ projectId: currentProjectId, mode, riskIds: orderedIds });
  }, [currentProjectId, riskItems]);

  const performRiskStructure = useCallback(async (
    operation: "INSERT" | "COPY" | "MOVE",
    anchorRiskId: string,
    position: "BEFORE" | "AFTER",
  ) => {
    if (!currentProjectId) return;
    const sourceRiskIds = operation === "INSERT" ? [] : clipboard?.riskIds ?? [];
    if (operation !== "INSERT" && (!clipboard || clipboard.projectId !== currentProjectId)) return;
    if (operation === "MOVE" && sourceRiskIds.includes(anchorRiskId)) {
      alert("剪切的风险不能粘贴到自身，请选择其他目标行");
      return;
    }

    const label = operation === "INSERT" ? "插入风险" : operation === "COPY" ? "复制粘贴风险" : "剪切移动风险";
    try {
      const result = await runWithHistory(label, sourceRiskIds, () => (
        api.post<RiskStructureResult>(`/api/projects/${currentProjectId}/risk-register/structure`, {
          operation,
          anchorRiskId,
          position,
          sourceRiskIds,
          count: 1,
        })
      ));
      const targetIds = result.createdRiskIds.length > 0 ? result.createdRiskIds : result.movedRiskIds;
      const refreshedRisks = await fetchData();
      setSelectedIds(targetIds);
      setSelectionAnchorId(targetIds.at(-1) ?? null);
      if (operation === "MOVE") setClipboard(null);
      if (operation === "INSERT" && targetIds[0]) {
        const created = refreshedRisks?.find((candidate) => candidate.id === targetIds[0]);
        if (created) {
          const value = created.riskName;
          setEditingCell({ id: created.id, field: "riskName" });
          setValidationErrors([]);
          setEditValue(value);
          editValueRef.current = value;
        }
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : `${label}失败`);
    }
  }, [clipboard, currentProjectId, fetchData, runWithHistory]);

  const riskContextActions = (item?: RiskRegisterItem, targetIds: string[] = []): TableContextMenuAction[] => {
    const clipboardReady = Boolean(clipboard && clipboard.projectId === currentProjectId);
    const invalidMoveTarget = Boolean(item && clipboard?.mode === "MOVE" && clipboard.riskIds.includes(item.id));
    return [
      ...(item && canEdit
        ? [
            { label: "剪切", icon: <Scissors className="size-4" />, shortcut: "Ctrl/Cmd+X", onSelect: () => copyOrCutRisks("MOVE", targetIds) },
            { label: "复制", icon: <Copy className="size-4" />, shortcut: "Ctrl/Cmd+C", onSelect: () => copyOrCutRisks("COPY", targetIds) },
            {
              label: "粘贴",
              icon: <ClipboardPaste className="size-4" />,
              disabled: !clipboardReady,
              children: [
                { label: "粘贴到行上方", disabled: invalidMoveTarget, onSelect: () => performRiskStructure(clipboard?.mode ?? "COPY", item.id, "BEFORE") },
                { label: "粘贴到行下方", disabled: invalidMoveTarget, onSelect: () => performRiskStructure(clipboard?.mode ?? "COPY", item.id, "AFTER") },
              ],
            },
          ]
        : []),
      ...(item && canCreate
        ? [{
            label: "插入",
            icon: <Plus className="size-4" />,
            separatorBefore: true,
            children: [
              { label: "在上方插入 1 条风险", onSelect: () => performRiskStructure("INSERT", item.id, "BEFORE") },
              { label: "在下方插入 1 条风险", onSelect: () => performRiskStructure("INSERT", item.id, "AFTER") },
            ],
          }]
        : []),
      ...(item && canDelete
        ? [{ label: targetIds.length > 1 ? `删除已选 ${targetIds.length} 条风险` : "删除此风险", icon: <Trash2 className="size-3.5" />, destructive: true, separatorBefore: true, onSelect: () => targetIds.length > 1 ? deleteSelected(targetIds) : deleteRisk(item) }]
        : []),
      ...(!item && canCreate && currentProjectId
        ? [{ label: "新增风险", icon: <Plus className="size-3.5" />, onSelect: openCreate }]
        : []),
      ...(!item && canDelete && selectedIds.length > 0
        ? [{ label: `删除已选 ${selectedIds.length} 条风险`, icon: <Trash2 className="size-3.5" />, destructive: true, onSelect: () => deleteSelected() }]
        : []),
    ];
  };

  const openRiskContextMenu = (event: MouseEvent<HTMLElement>, item: RiskRegisterItem) => {
    const targetIds = selectedIds.includes(item.id) ? selectedIds : [item.id];
    if (!selectedIds.includes(item.id)) {
      setSelectedIds([item.id]);
      setSelectionAnchorId(item.id);
    }
    openContextMenu(event, riskContextActions(item, targetIds), {
      title: `${item.riskCode} · ${item.riskName}`,
      description: targetIds.length > 1 ? `已选择 ${targetIds.length} 条风险` : undefined,
    });
  };

  useEffect(() => {
    const handleClipboardShortcut = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || Boolean(target?.isContentEditable);
      if (editing || (!event.metaKey && !event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "c" && selectedIds.length > 0) {
        event.preventDefault();
        copyOrCutRisks("COPY", selectedIds);
      } else if (key === "x" && selectedIds.length > 0) {
        event.preventDefault();
        copyOrCutRisks("MOVE", selectedIds);
      } else if (key === "v" && selectedIds.length > 0 && clipboard?.projectId === currentProjectId) {
        event.preventDefault();
        void performRiskStructure(clipboard.mode, selectedIds[0], "AFTER");
      }
    };
    window.addEventListener("keydown", handleClipboardShortcut);
    return () => window.removeEventListener("keydown", handleClipboardShortcut);
  }, [clipboard, copyOrCutRisks, currentProjectId, performRiskStructure, selectedIds]);

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
      await runWithHistory("调整风险排序", [movedRiskId], () => (
        api.post(`/api/projects/${currentProjectId}/risk-register/reorder`, { riskIds: nextRiskIds })
      ));
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
          className={cn(inputClass, validationErrors.includes(field) && "border-destructive ring-1 ring-destructive/30")}
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
    <>
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">风险登记册</CardTitle>
          <div className="flex items-center gap-2">
            {(canCreate || canEdit || canDelete) && (
              <div className="flex items-center gap-2" role="group" aria-label="撤销与重做">
                <Button type="button" size="icon" variant="outline" className="size-8" disabled={!undoEntry || historyBusy} onClick={() => void undo()} title={undoEntry ? `撤销：${undoEntry.label}` : "没有可撤销的操作"} aria-label="撤销">
                  <Undo2 className="size-3.5" />
                </Button>
                <Button type="button" size="icon" variant="outline" className="size-8" disabled={!redoEntry || historyBusy} onClick={() => void redo()} title={redoEntry ? `重做：${redoEntry.label}` : "没有可重做的操作"} aria-label="重做">
                  <Redo2 className="size-3.5" />
                </Button>
              </div>
            )}
            {reordering && <span className="text-xs text-muted-foreground">排序保存中...</span>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table onContextMenu={(event) => openContextMenu(event, riskContextActions())}>
          <TableHeader>
            <TableRow>
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
              <TableRow ref={activeEditRowRef} className="align-top bg-primary/5" onKeyDownCapture={handleCreateKeyDown} onBlurCapture={handleCreateBlur}>
                <TableCell className="text-xs text-muted-foreground">-</TableCell>
                <TableCell className="whitespace-nowrap font-mono text-[11px] font-semibold text-muted-foreground">保存后生成</TableCell>
                <TableCell>
                  <Input value={draft.riskName} onChange={(e) => updateDraft("riskName", e.target.value)} className={cn(`${inlineInputClass} min-w-[160px]`, validationErrors.includes("riskName") && "border-destructive ring-1 ring-destructive/30")} placeholder="风险名称" autoFocus />
                  {validationErrors.includes("riskName") && <span className="mt-1 block text-[10px] text-destructive">请填写风险名称</span>}
                </TableCell>
                <TableCell>
                  <HierarchicalMultiSelect
                    options={itemSelectOptions}
                    value={draft.weeklyItemIds ?? []}
                    onChange={(ids) => updateDraft("weeklyItemIds", ids)}
                    multiple
                    applyOnClose
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
                <TableCell>
                  <Input value={draft.owner} onChange={(e) => updateDraft("owner", e.target.value)} className={cn(`${inlineInputClass} w-[96px]`, validationErrors.includes("owner") && "border-destructive ring-1 ring-destructive/30")} placeholder="责任人" />
                  {validationErrors.includes("owner") && <span className="mt-1 block text-[10px] text-destructive">请填写责任人</span>}
                </TableCell>
                <TableCell><Select value={draft.status} onChange={(e) => updateDraft("status", e.target.value)} className={inlineSelectClass}>{riskStatusOptions.map((o) => (<option key={o} value={o}>{o}</option>))}</Select></TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Input type="date" value={draft.targetDate} onChange={(e) => updateDraft("targetDate", e.target.value)} className={`${inlineInputClass} w-[122px]`} />
                    <Button size="sm" className="h-7 text-xs" onClick={() => void submitCreate()}>保存</Button>
                    <TableActionButton onClick={() => setDraft(null)}>取消</TableActionButton>
                  </div>
                </TableCell>
              </TableRow>
            )}
            {/* ---- 数据行 ---- */}
            {riskItems.map((item, index) => (
              <TableRow
                key={item.id}
                ref={editingCell?.id === item.id ? activeEditRowRef : undefined}
                data-table-row-id={item.id}
                draggable={canEdit && editingCell?.id !== item.id}
                onDragStart={(event) => {
                  if (!canEdit || editingCell?.id === item.id) return;
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
                onContextMenu={(event) => openRiskContextMenu(event, item)}
                className={
                  editingCell?.id === item.id
                    ? "align-top bg-primary/5"
                    : [
                        "cursor-grab align-top transition-[background,box-shadow,transform] duration-150 active:cursor-grabbing",
                        "bg-transparent",
                        "hover:bg-primary/5",
                        selectedIds.includes(item.id) ? "bg-primary/10 ring-1 ring-inset ring-primary/35" : "",
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
                <TableCell
                  className={cn("cursor-pointer select-none text-xs tabular-nums text-muted-foreground", selectedIds.includes(item.id) && "bg-primary/15 font-semibold text-primary")}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectFromSequence(item.id, event);
                  }}
                  title="单击选择；Ctrl/Cmd 多选；Shift 连选"
                >
                  {index + 1}
                </TableCell>
                <TableCell className="whitespace-nowrap font-mono text-[11px] font-semibold text-muted-foreground">{item.riskCode || `Risk${String(index + 1).padStart(3, "0")}`}</TableCell>
                <TableCell>
                  <div className="flex min-w-[180px] items-start gap-1">
                    <div className="min-w-0 flex-1">
                      {renderTextCell(item, "riskName", item.riskName, `${inlineInputClass} min-w-[150px]`, "风险名称")}
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7 shrink-0"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedRisk(item);
                      }}
                      title={`查看 ${item.riskCode} 风险明细`}
                      aria-label={`查看 ${item.riskCode} 风险明细`}
                    >
                      <Eye className="size-3.5" />
                    </Button>
                  </div>
                </TableCell>
                <TableCell>
                  <HierarchicalMultiSelect
                    options={itemSelectOptions}
                    value={item.weeklyItemIds ?? []}
                    onChange={(ids) => void commitSelectChange(item.id, "weeklyItemIds", ids)}
                    multiple
                    applyOnClose
                    disabled={!canEdit}
                    placeholder="不关联"
                    searchPlaceholder="搜索事项 ID、名称或 WBS 任务"
                    ariaLabel="关联项目事项"
                    className={`${inlineSelectClass} min-w-[220px] !border-transparent !bg-transparent hover:!border-transparent hover:!bg-transparent`}
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
                <TableCell colSpan={13} className="text-center text-muted-foreground text-xs py-8">
                  暂无风险条目{currentProjectId ? "，在表格中右击即可新增" : "，请先在项目列表中选择一个项目"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <TableContextMenu menu={menu} onClose={closeContextMenu} />
      </CardContent>
    </Card>

    <Dialog open={Boolean(selectedRisk)} onOpenChange={(open) => { if (!open) setSelectedRisk(null); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-mono text-sm text-primary">{selectedRisk?.riskCode}</span>
            <span className="truncate">{selectedRisk?.riskName || "风险明细"}</span>
          </DialogTitle>
          <DialogDescription>受影响任务由当前关联事项的 WBS 关联自动推导。</DialogDescription>
        </DialogHeader>
        {selectedRisk && (
          <div className="grid gap-x-5 md:grid-cols-2">
            <RiskDetailField label="风险ID" value={selectedRisk.riskCode} />
            <RiskDetailField label="风险名称" value={selectedRisk.riskName} />
            <RiskDetailField
              label="关联项目事项"
              value={(selectedRisk.linkedItems ?? []).map((item) => `${item.matterCode} · ${item.title}`).join("\n")}
              wide
            />
            <RiskDetailField
              label="受影响的 WBS 任务"
              value={(selectedRisk.affectedTasks ?? []).map((task) => `${task.taskCode || "未编号"} · ${task.taskName}`).join("\n")}
              wide
            />
            <RiskDetailField label="类别" value={selectedRisk.category} />
            <RiskDetailField label="状态" value={selectedRisk.status} />
            <RiskDetailField label="发生概率" value={selectedRisk.probability} />
            <RiskDetailField label="影响程度" value={selectedRisk.impact} />
            <RiskDetailField label="风险等级" value={selectedRisk.level} />
            <RiskDetailField label="责任人" value={selectedRisk.owner} />
            <RiskDetailField label="计划关闭日期" value={selectedRisk.targetDate} />
            <RiskDetailField label="触发条件" value={selectedRisk.trigger} wide />
            <RiskDetailField label="应对措施" value={selectedRisk.response} wide />
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}
