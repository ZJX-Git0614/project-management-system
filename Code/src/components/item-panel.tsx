"use client";

import { KeyboardEvent, type DragEvent, type FocusEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ClipboardPaste, Copy, Pencil, Plus, Redo2, Save, Scissors, Search, Trash2, Undo2, Upload } from "lucide-react";
import { ItemHealth, ItemRiskStatus, ItemStatus, ItemPriority } from "@/domain/enums";
import {
  ITEM_STATUS_LABEL,
  ITEM_PRIORITY_LABEL,
  ITEM_HEALTH_LABEL,
  ITEM_RISK_STATUS_LABEL,
} from "@/lib/constants";
import { cn, downloadTextFile, formatDateInput, toCsv, diffDays } from "@/lib/utils";
import { usePermission } from "@/lib/use-permission";
import { useConfirm } from "@/components/confirm-provider";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { TableContextMenu, type TableContextMenuAction, useTableContextMenu } from "@/components/table-context-menu";
import { HierarchicalMultiSelect, type HierarchicalSelectOption } from "@/components/hierarchical-multi-select";
import {
  ITEM_STATUS_VALUES,
  itemProgressFields,
  itemProgressInputValue,
  itemStatusFromProgress,
} from "@/lib/item-progress";
import { useModuleHistory } from "@/lib/use-module-history";
import { useCommitOnOutsidePointer } from "@/lib/use-commit-on-outside-pointer";

export type ItemKind = "monthly" | "weekly";

interface Project {
  id: string;
  name: string;
  code: string;
  status: string;
}

interface ProjectMember {
  id: string;
  roleName: string;
  personName: string;
}

interface ProjectOwnerOption {
  personName: string;
  label: string;
}

interface ProjectWithMembers extends Project {
  projectMembers?: ProjectMember[];
}

interface ItemRecord {
  id: string;
  projectId: string;
  matterCode?: string;
  sortOrder?: number;
  title: string;
  ganttTaskId?: string | null;
  ganttTaskIds: string[];
  taskName?: string;
  linkedTasks: ProjectGanttTaskOption[];
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
  linkedRisks: LinkedRisk[];
  createdAt: string;
  updatedAt: string;
  project?: {
    id: string;
    name: string;
    code: string;
    status: string;
  };
}

const normalizeItemRecord = (item: ItemRecord): ItemRecord => ({
  ...item,
  ganttTaskIds: item.ganttTaskIds?.length > 0
    ? item.ganttTaskIds
    : item.ganttTaskId ? [item.ganttTaskId] : [],
  linkedTasks: item.linkedTasks ?? [],
  status: itemStatusFromProgress(item.progress),
});

interface LinkedRisk {
  id: string;
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

const RiskDetailField = ({ label, value, wide = false }: { label: string; value?: string; wide?: boolean }) => (
  <div className={cn("min-w-0 border-b border-border/60 py-2.5", wide && "md:col-span-2")}>
    <div className="text-[11px] text-muted-foreground">{label}</div>
    <div className="mt-1 whitespace-pre-wrap break-words text-sm">{value || "-"}</div>
  </div>
);

const ItemStatusReadout = ({ progress, className }: { progress: number; className?: string }) => {
  const status = itemStatusFromProgress(progress);
  return (
    <div
      aria-readonly="true"
      className={cn(
        "flex h-8 items-center rounded-md border border-input bg-muted/40 px-2 text-xs text-muted-foreground",
        status === ItemStatus.DONE && "text-emerald-400",
        className,
      )}
    >
      {ITEM_STATUS_LABEL[status]}
    </div>
  );
};

type EditableField =
  | "title"
  | "description"
  | "ganttTaskIds"
  | "owner"
  | "priority"
  | "plannedStartDate"
  | "actualStartDate"
  | "plannedEndDate"
  | "actualEndDate"
  | "progress"
  | "health"
  | "issueAndAction"
  | "dependency";

interface ProjectGanttTaskOption {
  id: string;
  taskName: string;
  taskCode: string;
  taskCategory?: string;
  parentId?: string | null;
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

interface SavedItemView {
  id: string;
  name: string;
  keyword: string;
  projectFilter: string;
  statusFilter: string;
  healthFilter: string;
  updatedAt: string;
}

const PROGRESS_BAR_COLOR = (p: number) => {
  if (p >= 100) return "bg-emerald-500";
  if (p >= 60) return "bg-sky-500";
  if (p >= 30) return "bg-amber-500";
  return "bg-rose-500";
};

const DATE_CELL = (s?: string) => (s && s.length >= 10 ? s.slice(5) : "-");
const INLINE_INPUT_CLASS = "h-7 min-w-0 rounded border-border bg-background px-2 text-xs";
const INLINE_SELECT_CLASS = "h-7 min-w-0 rounded border-border bg-background px-2 text-xs";
const GHOST_SELECT_CLASS = "h-7 px-2 text-xs";
const PRIORITY_SELECT_CLASS = "h-7 !w-[88px] !min-w-[88px] !max-w-[88px] px-2 text-xs";
const INLINE_TEXTAREA_CLASS = "min-h-14 min-w-[160px] resize-y rounded border-border bg-background px-2 py-1 text-xs";
const ITEM_LONG_TEXT_HEADER_CLASS = "w-[200px] min-w-[200px] max-w-[200px] !whitespace-normal";
const ITEM_LONG_TEXT_CELL_CLASS = "w-[200px] min-w-[200px] max-w-[200px] overflow-hidden !whitespace-normal align-top !text-[10px] !leading-4";
const ITEM_LONG_TEXT_EDITOR_CLASS = "!h-[52px] !min-h-[52px] !max-h-[52px] !w-full !min-w-0 !max-w-full resize-none overflow-y-auto rounded border-border bg-background px-2 py-1 !text-[10px] !leading-4";
const FROZEN_HEADER_CLASS = "sticky z-40 !bg-muted";
const FROZEN_CELL_CLASS = "sticky z-20";
const FROZEN_EDGE_HEADER_CLASS = `${FROZEN_HEADER_CLASS} border-r border-border shadow-[5px_0_10px_-9px_hsl(var(--foreground))]`;
const FROZEN_EDGE_CELL_CLASS = `${FROZEN_CELL_CLASS} border-r border-border shadow-[5px_0_10px_-9px_hsl(var(--foreground))]`;
const FROZEN_ACTIVE_ROW_BACKGROUND = "!bg-transparent";
const FROZEN_TRANSPARENT_ROW_BACKGROUND = "!bg-transparent group-hover:!bg-transparent";
const frozenDataRowBackground = () => "!bg-transparent group-hover:!bg-transparent";
const CURRENT_VIEW_ID = "__current__";
type DropPosition = "before" | "after";
type ItemClipboard = {
  projectId: string;
  mode: "COPY" | "MOVE";
  itemIds: string[];
};

interface ItemStructureResult {
  createdItemIds: string[];
  movedItemIds: string[];
}

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
  const [taskOptions, setTaskOptions] = useState<ProjectGanttTaskOption[]>([]);
  const [ownerOptionsByProjectId, setOwnerOptionsByProjectId] = useState<Record<string, ProjectOwnerOption[]>>({});
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [projectFilter, setProjectFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [healthFilter, setHealthFilter] = useState("ALL");
  const [savedViews, setSavedViews] = useState<SavedItemView[]>([]);
  const [selectedViewId, setSelectedViewId] = useState(CURRENT_VIEW_ID);
  const [viewName, setViewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<EditableField | null>(null);
  const [draft, setDraft, clearDraft] = useDraftedState<ItemRecord | null>(
    `pms.draft.item.${kind}`,
    null
  );
  const [saving, setSaving] = useState(false);
  const draftRef = useRef<ItemRecord | null>(null);
  const submittingRef = useRef(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<ItemClipboard | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [itemDropTarget, setItemDropTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  const [reordering, setReordering] = useState(false);
  const [selectedRisk, setSelectedRisk] = useState<LinkedRisk | null>(null);
  const activeEditRowRef = useRef<HTMLTableRowElement>(null);
  const { menu, openContextMenu, closeContextMenu } = useTableContextMenu();

  const canView = can(`${kind}-items:view`);
  const canCreate = can(`${kind}-items:create`);
  const canEdit = can(`${kind}-items:edit`) || can("account-management:view");
  const canDelete = can(`${kind}-items:delete`);
  const canExport = can(`${kind}-items:export`);
  const isWeekly = kind === "weekly";
  const tableColSpan = isWeekly ? 17 : 16;
  const sequenceColumnLeft = 0;
  const matterCodeColumnLeft = sequenceColumnLeft + 64;
  const titleColumnLeft = matterCodeColumnLeft + (isWeekly ? 120 : 0);
  const savedViewStorageKey = `pms.saved-views.item.${kind}`;

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    setClipboard(null);
  }, [currentProjectId]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(savedViewStorageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        setSavedViews(
          parsed.filter((view): view is SavedItemView =>
            view &&
            typeof view.id === "string" &&
            typeof view.name === "string" &&
            typeof view.keyword === "string" &&
            typeof view.projectFilter === "string" &&
            typeof view.statusFilter === "string" &&
            typeof view.healthFilter === "string",
          ),
        );
      }
    } catch {
      setSavedViews([]);
    }
  }, [savedViewStorageKey]);

  const persistSavedViews = (views: SavedItemView[]) => {
    setSavedViews(views);
    window.localStorage.setItem(savedViewStorageKey, JSON.stringify(views));
  };

  const markCustomView = () => {
    setSelectedViewId(CURRENT_VIEW_ID);
  };

  const applySavedView = (viewId: string) => {
    setSelectedViewId(viewId);
    if (viewId === CURRENT_VIEW_ID) return;

    const view = savedViews.find((item) => item.id === viewId);
    if (!view) return;
    setKeyword(view.keyword);
    setProjectFilter(view.projectFilter);
    setStatusFilter(ITEM_STATUS_VALUES.includes(view.statusFilter as ItemStatus) ? view.statusFilter : "ALL");
    setHealthFilter(view.healthFilter);
    setViewName(view.name);
  };

  const saveCurrentView = () => {
    const name = viewName.trim();
    if (!name) {
      alert("请填写视图名称");
      return;
    }

    const id = selectedViewId !== CURRENT_VIEW_ID ? selectedViewId : `view-${encodeURIComponent(name)}`;
    const nextView: SavedItemView = {
      id,
      name,
      keyword,
      projectFilter,
      statusFilter,
      healthFilter,
      updatedAt: "",
    };
    const nextViews = [
      nextView,
      ...savedViews.filter((view) => view.id !== id && view.name !== name),
    ].slice(0, 12);
    persistSavedViews(nextViews);
    setSelectedViewId(id);
  };

  const deleteCurrentView = () => {
    if (selectedViewId === CURRENT_VIEW_ID) return;
    const nextViews = savedViews.filter((view) => view.id !== selectedViewId);
    persistSavedViews(nextViews);
    setSelectedViewId(CURRENT_VIEW_ID);
    setViewName("");
  };

  const fetchData = useCallback(async ({ showLoading = true }: { showLoading?: boolean } = {}) => {
    if (!canView) {
      setLoading(false);
      return [] as ItemRecord[];
    }
    if (showLoading) setLoading(true);
    try {
      const dateQuery = dateRange.start || dateRange.end
        ? `?startDate=${encodeURIComponent(dateRange.start)}&endDate=${encodeURIComponent(dateRange.end)}`
        : "";
      const [itemList, projectList] = await Promise.all([
        api.get<ItemRecord[]>(`${apiPath}${dateQuery}`),
        api.get<Project[]>("/api/projects"),
      ]);
      const normalizedItems = itemList.map(normalizeItemRecord);
      setItems(normalizedItems);
      setProjects(projectList);
      return normalizedItems;
    } catch {
      return [] as ItemRecord[];
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [canView, apiPath, dateRange.start, dateRange.end]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleHistoryRestored = useCallback(async (targetIds: string[]) => {
    setEditingId(null);
    setEditingField(null);
    setValidationErrors([]);
    clearDraft();
    setSelectedIds(targetIds);
    setSelectionAnchorId(targetIds.at(-1) ?? null);
    await fetchData({ showLoading: false });
  }, [clearDraft, fetchData]);

  const {
    undo,
    redo,
    runWithHistory,
    undoEntry,
    redoEntry,
    historyBusy,
  } = useModuleHistory({
    projectId: currentProjectId ?? "",
    module: "WEEKLY_ITEMS",
    enabled: isWeekly && Boolean(currentProjectId),
    onRestored: handleHistoryRestored,
    onError: (errorTitle, message) => alert(`${errorTitle}\n${message}`),
    onWarning: (message) => alert(message),
  });

  const runItemAction = useCallback(<T,>(label: string, targetIds: string[], action: () => Promise<T>) => (
    isWeekly && currentProjectId ? runWithHistory(label, targetIds, action) : action()
  ), [currentProjectId, isWeekly, runWithHistory]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return items.filter((item) => {
      const hitKw = !kw
        || item.title.toLowerCase().includes(kw)
        || item.owner.toLowerCase().includes(kw)
        || (item.matterCode ?? "").toLowerCase().includes(kw)
        || (item.taskName ?? "").toLowerCase().includes(kw);
      const hitProject = projectFilter === "ALL" || item.projectId === projectFilter;
      const hitStatus = statusFilter === "ALL" || itemStatusFromProgress(item.progress) === statusFilter;
      const hitHealth = healthFilter === "ALL" || item.health === healthFilter;
      return hitKw && hitProject && hitStatus && hitHealth;
    });
  }, [items, keyword, projectFilter, statusFilter, healthFilter]);

  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        const sortCompare = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
        if (sortCompare !== 0) return sortCompare;
        const dateA = a.plannedStartDate || a.dueDate;
        const dateB = b.plannedStartDate || b.dueDate;
        return dateA.localeCompare(dateB) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      }),
    [filtered]
  );

  useEffect(() => {
    setSelectedIds((prev) => prev.filter((id) => sorted.some((item) => item.id === id)));
    setSelectionAnchorId((prev) => prev && sorted.some((item) => item.id === prev) ? prev : null);
  }, [sorted]);

  const selectFromSequence = (itemId: string, event: MouseEvent<HTMLElement>) => {
    const itemIndex = sorted.findIndex((item) => item.id === itemId);
    if (itemIndex < 0) return;

    if (event.shiftKey && selectionAnchorId) {
      const anchorIndex = sorted.findIndex((item) => item.id === selectionAnchorId);
      if (anchorIndex >= 0) {
        const [start, end] = [anchorIndex, itemIndex].sort((a, b) => a - b);
        const rangeIds = sorted.slice(start, end + 1).map((item) => item.id);
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

  const handleExport = () => {
    const rows = sorted.map((it, index) => {
      const startDev = diffDays(it.plannedStartDate, it.actualStartDate);
      return [
        String(index + 1),
        ...(isWeekly ? [it.matterCode || "-", it.title, it.taskName || "-"] : [it.title]),
        it.owner,
        ITEM_PRIORITY_LABEL[it.priority as ItemPriority] ?? it.priority,
        it.plannedStartDate || "-",
        it.plannedEndDate || "-",
        it.actualStartDate || "-",
        it.actualEndDate || "-",
        startDev === null ? "-" : (startDev === 0 ? "0" : (startDev > 0 ? `+${startDev}` : `${startDev}`)),
        `${it.progress}%`,
        ITEM_STATUS_LABEL[itemStatusFromProgress(it.progress)],
        ITEM_HEALTH_LABEL[it.health as ItemHealth] ?? it.health,
        it.issueAndAction || "-",
        it.dependency || "-",
        it.linkedRisks?.map((risk) => `${risk.riskCode} · ${risk.riskName}`).join("；") || "-",
        ITEM_RISK_STATUS_LABEL[it.riskStatus as ItemRiskStatus] ?? it.riskStatus,
        it.remark || "-",
      ];
    });
    const csv = toCsv(csvHeaders, rows);
    downloadTextFile(`${csvFilename}_${Date.now()}.csv`, csv);
  };

  const getOwnerOptions = useCallback(
    (projectId?: string, currentOwner?: string): ProjectOwnerOption[] => {
      const options = projectId ? ownerOptionsByProjectId[projectId] ?? [] : [];
      if (!currentOwner || options.some((option) => option.personName === currentOwner)) {
        return options;
      }
      return [...options, { personName: currentOwner, label: `${currentOwner}（当前值）` }];
    },
    [ownerOptionsByProjectId],
  );

  const taskSelectOptions = useMemo<HierarchicalSelectOption[]>(
    () => taskOptions.map((task) => ({
      id: task.id,
      label: task.taskCode || "未编号",
      secondaryLabel: [task.taskName, task.taskCategory].filter(Boolean).join(" · "),
      parentId: task.parentId ?? null,
    })),
    [taskOptions],
  );

  const openCreate = () => {
    const ownerOptions = getOwnerOptions(currentProjectId ?? undefined);
    const defaultOwner =
      ownerOptions.find((option) => option.personName === user?.displayName)?.personName
      ?? ownerOptions[0]?.personName
      ?? "";
    setEditingId(null);
    setEditingField(null);
    setValidationErrors([]);
    setDraft({
      id: "",
      projectId: currentProjectId ?? "",
      matterCode: "",
      ganttTaskId: null,
      ganttTaskIds: [],
      title: "",
      taskName: "",
      linkedTasks: [],
      description: "",
      dueDate: "",
      status: ItemStatus.PENDING,
      owner: defaultOwner,
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
      linkedRisks: [],
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

  const openEdit = (item: ItemRecord, field: EditableField) => {
    if (editingId === item.id && draft?.id === item.id) {
      setEditingField(field);
      return;
    }
    setEditingId(item.id);
    setEditingField(field);
    setValidationErrors([]);
    setDraft({ ...item, status: itemStatusFromProgress(item.progress) });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingField(null);
    setValidationErrors([]);
    clearDraft();
  };

  const updateDraft = <K extends keyof ItemRecord>(key: K, value: ItemRecord[K]) => {
    setValidationErrors((prev) => prev.filter((field) => field !== key));
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const updateDraftProgress = (progress: number) => {
    setValidationErrors((prev) => prev.filter((field) => field !== "progress"));
    setDraft((prev) => (prev ? {
      ...prev,
      ...itemProgressFields(progress, prev.actualEndDate, undefined, prev.progress),
    } : prev));
  };

  const commitSelectChange = async <K extends keyof ItemRecord>(key: K, value: ItemRecord[K], itemOverride?: ItemRecord) => {
    const base = itemOverride ?? draftRef.current;
    if (!base) {
      console.warn("commitSelectChange: no base item");
      return;
    }
    if (!base.id) {
      updateDraft(key, value);
      return;
    }
    const updated = { ...base, [key]: value };
    if (Object.is(base[key], value)) return;
    if (!updated.title.trim() || !updated.owner.trim() || updated.progress < 0 || updated.progress > 100) {
      console.warn("commitSelectChange: validation failed", { title: updated.title, progress: updated.progress });
      return;
    }
    setSaving(true);
    let previousItems: ItemRecord[] | null = null;
    setItems((prev) => {
      previousItems = prev;
      return prev.map((item) => (item.id === updated.id ? updated : item));
    });
    try {
      await runItemAction(`修改事项「${updated.title}」`, [updated.id], async () => {
        const { id: _id, createdAt: _ca, updatedAt: _ua, project: _p, matterCode: _mc, linkedRisks: _lr, linkedTasks: _lt, ...payload } = updated;
        void _id; void _ca; void _ua; void _p; void _mc; void _lr; void _lt;
        const savedItem = normalizeItemRecord(
          await api.put<ItemRecord>(`${apiPath}/${updated.id}`, payload),
        );
        setItems((prev) => prev.map((item) => (item.id === savedItem.id ? savedItem : item)));
        flushSync(() => {
          cancelEdit();
        });
      });
    } catch (error) {
      if (previousItems) {
        setItems(previousItems);
      }
      console.error("commitSelectChange error:", error);
      alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!isWeekly) {
      setTaskOptions([]);
      return;
    }

    // 从当前事项列表 + 正在编辑的草稿中收集唯一的 projectId
    const ids = new Set(items.map((item) => item.projectId).filter(Boolean));
    if (draft?.projectId) ids.add(draft.projectId);
    const projectIds = [...ids];
    if (projectIds.length === 0) {
      setTaskOptions([]);
      return;
    }

    let alive = true;
    Promise.all(
      projectIds.map((pid) =>
        api.get<ProjectGanttTaskOption[]>(`/api/projects/${pid}/gantt-tasks`).catch(() => [] as ProjectGanttTaskOption[])
      )
    )
      .then((results) => {
        if (!alive) return;
        const allTasks = results.flat().filter((task) => task.taskName.trim());
        const seen = new Set<string>();
        setTaskOptions(allTasks.filter((task) => {
          if (seen.has(task.id)) return false;
          seen.add(task.id);
          return true;
        }));
      })
      .catch(() => {
        if (alive) setTaskOptions([]);
      });

    return () => {
      alive = false;
    };
  }, [items, draft?.projectId, isWeekly]);

  useEffect(() => {
    if (!isWeekly) {
      setOwnerOptionsByProjectId({});
      return;
    }

    const ids = new Set(items.map((item) => item.projectId).filter(Boolean));
    if (currentProjectId) ids.add(currentProjectId);
    if (draft?.projectId) ids.add(draft.projectId);
    const projectIds = [...ids];
    if (projectIds.length === 0) {
      setOwnerOptionsByProjectId({});
      return;
    }

    let alive = true;
    Promise.all(
      projectIds.map((pid) =>
        api.get<ProjectWithMembers>(`/api/projects/${pid}`).catch(() => null)
      )
    )
      .then((results) => {
        if (!alive) return;
        const next: Record<string, ProjectOwnerOption[]> = {};
        results.forEach((project, index) => {
          const projectId = project?.id ?? projectIds[index];
          const roleNamesByPerson = new Map<string, Set<string>>();
          (project?.projectMembers ?? []).forEach((member) => {
            if (!member.personName.trim()) return;
            const roles = roleNamesByPerson.get(member.personName) ?? new Set<string>();
            if (member.roleName.trim()) roles.add(member.roleName);
            roleNamesByPerson.set(member.personName, roles);
          });
          next[projectId] = [...roleNamesByPerson.entries()].map(([personName, roleNames]) => {
            const roles = [...roleNames];
            return {
              personName,
              label: roles.length > 0 ? `${personName}（${roles.join("、")}）` : personName,
            };
          });
        });
        setOwnerOptionsByProjectId(next);
      })
      .catch(() => {
        if (alive) setOwnerOptionsByProjectId({});
      });

    return () => {
      alive = false;
    };
  }, [currentProjectId, draft?.projectId, isWeekly, items]);

  const validateDraft = (item: ItemRecord) => {
    const errors: string[] = [];
    if (!item.title.trim()) errors.push("title");
    if (!item.owner.trim()) errors.push("owner");
    if (item.progress < 0 || item.progress > 100) errors.push("progress");
    setValidationErrors(errors);
    return errors.length === 0;
  };

  const submitCreate = async () => {
    if (!draft || submittingRef.current) return;
    if (!currentProjectId) {
      alert("请先从项目列表中选择当前项目");
      return;
    }
    if (!validateDraft(draft)) return;
    submittingRef.current = true;
    setSaving(true);
    try {
      const targetIds: string[] = [];
      await runItemAction(`新增事项「${draft.title.trim()}」`, targetIds, async () => {
        const { id: _id, createdAt: _ca, updatedAt: _ua, project: _p, matterCode: _mc, linkedRisks: _lr, linkedTasks: _lt, ...payload } = draft;
        void _id; void _ca; void _ua; void _p; void _mc; void _lr; void _lt;
        const savedItem = normalizeItemRecord(await api.post<ItemRecord>(apiPath, payload));
        targetIds.push(savedItem.id);
        setItems((prev) => [...prev.filter((item) => item.id !== savedItem.id), savedItem]);
        clearDraft();
        setValidationErrors([]);
      });
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  const submitEdit = async () => {
    if (!draft || submittingRef.current) return;
    if (!validateDraft(draft)) return;
    submittingRef.current = true;
    setSaving(true);
    try {
      await runItemAction(`编辑事项「${draft.title.trim()}」`, [draft.id], async () => {
        const { id: _id, createdAt: _ca, updatedAt: _ua, project: _p, matterCode: _mc, linkedRisks: _lr, linkedTasks: _lt, ...payload } = draft;
        void _id; void _ca; void _ua; void _p; void _mc; void _lr; void _lt;
        const savedItem = normalizeItemRecord(
          await api.put<ItemRecord>(`${apiPath}/${draft.id}`, payload),
        );
        setItems((prev) => prev.map((item) => (item.id === savedItem.id ? savedItem : item)));
        cancelEdit();
      });
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  const handleEditKeyDown = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
      return;
    }
    if (event.key !== "Enter") return;
    if (event.currentTarget instanceof HTMLTextAreaElement && event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.blur();
  };

  const handleCreateKeyDown = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
      return;
    }
    if (event.key !== "Enter") return;
    if (event.currentTarget instanceof HTMLTextAreaElement && event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.blur();
  };

  const editTriggerProps = (item: ItemRecord, field: EditableField) => {
    if (!canEdit) return {};
    return {
      role: "button" as const,
      tabIndex: 0,
      onClick: () => openEdit(item, field),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openEdit(item, field);
        }
      },
    };
  };

  const handleDraftBlur = (event: FocusEvent<HTMLElement>, mode: "create" | "edit") => {
    const nextElement = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
    if (nextElement?.closest('[data-slot="dropdown-menu-content"]')) return;
    const nextTarget = nextElement as Node | null;
    if (nextTarget && event.currentTarget.contains(nextTarget)) return;
    void (mode === "create" ? submitCreate() : submitEdit());
  };

  useCommitOnOutsidePointer(Boolean(draft), activeEditRowRef, () => (
    editingId === null ? submitCreate() : submitEdit()
  ));

  const deleteConfirmation = (targetItems: ItemRecord[]) => {
    const linkedRisks = [...new Map(
      targetItems.flatMap((item) => item.linkedRisks ?? []).map((risk) => [risk.id, risk]),
    ).values()];
    const targetLabel = targetItems.length === 1
      ? `事项「${targetItems[0].title}」`
      : `选中的 ${targetItems.length} 个事项`;
    if (linkedRisks.length === 0) return `确认删除${targetLabel}？`;
    const relationships = linkedRisks.map((risk) => `${risk.riskCode} · ${risk.riskName}`).join("、");
    return `确认删除${targetLabel}？\n当前与以下风险存在关联：${relationships}\n删除后将移除这些风险与被删事项的关联，其余事项关联保持不变；撤销删除可恢复原关联。`;
  };

  const handleDeleteSelected = async (ids: string[] = selectedIds) => {
    const selectedItems = sorted.filter((item) => ids.includes(item.id));
    if (selectedItems.length === 0) return;
    if (!(await confirm(deleteConfirmation(selectedItems)))) return;
    setDeletingSelected(true);
    try {
      await runItemAction(`删除 ${selectedItems.length} 个事项`, selectedItems.map((item) => item.id), async () => {
        await Promise.all(selectedItems.map((item) => api.delete(`${apiPath}/${item.id}`)));
      });
      setSelectedIds([]);
      setSelectionAnchorId(null);
      await fetchData({ showLoading: false });
    } catch (err) {
      alert(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeletingSelected(false);
    }
  };

  const handleDeleteItem = async (item: ItemRecord) => {
    if (!(await confirm(deleteConfirmation([item])))) return;
    try {
      await runItemAction(`删除事项「${item.title}」`, [item.id], () => api.delete(`${apiPath}/${item.id}`));
      await fetchData({ showLoading: false });
    } catch (error) {
      alert(error instanceof Error ? error.message : "删除失败");
    }
  };

  const copyOrCutItems = useCallback((mode: ItemClipboard["mode"], ids: string[]) => {
    if (!currentProjectId || ids.length === 0) return;
    const orderedIds = sorted.filter((item) => ids.includes(item.id)).map((item) => item.id);
    setClipboard({ projectId: currentProjectId, mode, itemIds: orderedIds });
  }, [currentProjectId, sorted]);

  const performItemStructure = useCallback(async (
    operation: "INSERT" | "COPY" | "MOVE",
    anchorItemId: string,
    position: "BEFORE" | "AFTER",
  ) => {
    if (!currentProjectId || !isWeekly) return;
    const sourceItemIds = operation === "INSERT" ? [] : clipboard?.itemIds ?? [];
    if (operation !== "INSERT" && (!clipboard || clipboard.projectId !== currentProjectId)) return;
    if (operation === "MOVE" && sourceItemIds.includes(anchorItemId)) {
      alert("剪切的事项不能粘贴到自身，请选择其他目标行");
      return;
    }

    const label = operation === "INSERT" ? "插入事项" : operation === "COPY" ? "复制粘贴事项" : "剪切移动事项";
    try {
      const result = await runItemAction(label, sourceItemIds, () => (
        api.post<ItemStructureResult>("/api/weekly-items/structure", {
          projectId: currentProjectId,
          operation,
          anchorItemId,
          position,
          sourceItemIds,
          count: 1,
        })
      ));
      const targetIds = result.createdItemIds.length > 0 ? result.createdItemIds : result.movedItemIds;
      const refreshedItems = await fetchData({ showLoading: false });
      setSelectedIds(targetIds);
      setSelectionAnchorId(targetIds.at(-1) ?? null);
      if (operation === "MOVE") setClipboard(null);
      if (operation === "INSERT" && targetIds[0]) {
        const created = refreshedItems?.find((candidate) => candidate.id === targetIds[0]);
        if (created) {
          setEditingId(created.id);
          setEditingField("title");
          setValidationErrors([]);
          setDraft({ ...created, status: itemStatusFromProgress(created.progress) });
        }
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : `${label}失败`);
    }
  }, [clipboard, currentProjectId, fetchData, isWeekly, runItemAction, setDraft]);

  const itemContextActions = (item?: ItemRecord, targetIds: string[] = []): TableContextMenuAction[] => {
    const clipboardReady = Boolean(clipboard && clipboard.projectId === currentProjectId);
    const invalidMoveTarget = Boolean(item && clipboard?.mode === "MOVE" && clipboard.itemIds.includes(item.id));
    return [
      ...(item && canEdit && isWeekly
        ? [
            { label: "剪切", icon: <Scissors className="size-4" />, shortcut: "Ctrl/Cmd+X", onSelect: () => copyOrCutItems("MOVE", targetIds) },
            { label: "复制", icon: <Copy className="size-4" />, shortcut: "Ctrl/Cmd+C", onSelect: () => copyOrCutItems("COPY", targetIds) },
            {
              label: "粘贴",
              icon: <ClipboardPaste className="size-4" />,
              disabled: !clipboardReady,
              children: [
                { label: "粘贴到行上方", disabled: invalidMoveTarget, onSelect: () => performItemStructure(clipboard?.mode ?? "COPY", item.id, "BEFORE") },
                { label: "粘贴到行下方", disabled: invalidMoveTarget, onSelect: () => performItemStructure(clipboard?.mode ?? "COPY", item.id, "AFTER") },
              ],
            },
          ]
        : []),
      ...(item && canCreate && isWeekly
        ? [{
            label: "插入",
            icon: <Plus className="size-4" />,
            separatorBefore: true,
            children: [
              { label: "在上方插入 1 条事项", onSelect: () => performItemStructure("INSERT", item.id, "BEFORE") },
              { label: "在下方插入 1 条事项", onSelect: () => performItemStructure("INSERT", item.id, "AFTER") },
            ],
          }]
        : []),
      ...(item && targetIds.length === 1 && canEdit
        ? [{ label: "编辑事项", icon: <Pencil className="size-3.5" />, separatorBefore: true, onSelect: () => openEdit(item, "title") }]
        : []),
      ...(item && canDelete
        ? [{
            label: targetIds.length > 1 ? `删除已选 ${targetIds.length} 个事项` : "删除此事项",
            icon: <Trash2 className="size-3.5" />,
            destructive: true,
            separatorBefore: true,
            onSelect: () => targetIds.length > 1 ? handleDeleteSelected(targetIds) : handleDeleteItem(item),
          }]
        : []),
      ...(!item && canCreate && currentProjectId
        ? [{ label: "新增事项", icon: <Plus className="size-3.5" />, onSelect: openCreate }]
        : []),
      ...(!item && canDelete && selectedIds.length > 0
        ? [{ label: `删除已选 ${selectedIds.length} 个事项`, icon: <Trash2 className="size-3.5" />, destructive: true, onSelect: () => handleDeleteSelected() }]
        : []),
    ];
  };

  const openItemContextMenu = (event: MouseEvent<HTMLElement>, item: ItemRecord) => {
    const targetIds = selectedIds.includes(item.id) ? selectedIds : [item.id];
    if (!selectedIds.includes(item.id)) {
      setSelectedIds([item.id]);
      setSelectionAnchorId(item.id);
    }
    openContextMenu(event, itemContextActions(item, targetIds), {
      title: `${item.matterCode || "事项"} · ${item.title}`,
      description: targetIds.length > 1 ? `已选择 ${targetIds.length} 个事项` : undefined,
    });
  };

  useEffect(() => {
    if (!isWeekly) return;
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
        copyOrCutItems("COPY", selectedIds);
      } else if (key === "x" && selectedIds.length > 0) {
        event.preventDefault();
        copyOrCutItems("MOVE", selectedIds);
      } else if (key === "v" && selectedIds.length > 0 && clipboard?.projectId === currentProjectId) {
        event.preventDefault();
        void performItemStructure(clipboard.mode, selectedIds[0], "AFTER");
      }
    };
    window.addEventListener("keydown", handleClipboardShortcut);
    return () => window.removeEventListener("keydown", handleClipboardShortcut);
  }, [clipboard, copyOrCutItems, currentProjectId, isWeekly, performItemStructure, selectedIds]);

  const getDropPosition = (event: DragEvent<HTMLElement>): DropPosition => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };

  const reorderItems = async (targetItemId: string, position: DropPosition) => {
    if (!draggedItemId || draggedItemId === targetItemId || reordering) return;
    const itemIds = sorted.map((item) => item.id);
    const fromIndex = itemIds.indexOf(draggedItemId);
    const toIndex = itemIds.indexOf(targetItemId);
    if (fromIndex < 0 || toIndex < 0) return;

    const nextItemIds = [...itemIds];
    const [movedItemId] = nextItemIds.splice(fromIndex, 1);
    const targetIndexAfterRemoval = nextItemIds.indexOf(targetItemId);
    nextItemIds.splice(position === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval, 0, movedItemId);

    setReordering(true);
    setItems((prev) => {
      const sortById = new Map(nextItemIds.map((id, index) => [id, index + 1]));
      return prev.map((item) => (
        sortById.has(item.id) ? { ...item, sortOrder: sortById.get(item.id)! } : item
      ));
    });

    try {
      await runItemAction("调整事项排序", [movedItemId], () => (
        api.post("/api/weekly-items/reorder", { itemIds: nextItemIds })
      ));
      await fetchData({ showLoading: false });
    } catch (error) {
      alert(error instanceof Error ? error.message : "排序保存失败");
      await fetchData({ showLoading: false });
    } finally {
      setReordering(false);
      setDraggedItemId(null);
      setItemDropTarget(null);
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
                {description}
                {dateRange.start && dateRange.end ? ` · 时间窗口 ${dateRange.start} ~ ${dateRange.end}` : ""}
              </CardDescription>
            </div>
            {isWeekly && (canCreate || canEdit || canDelete) && (
              <div className="flex items-center gap-2" role="group" aria-label="撤销与重做">
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="size-8"
                  disabled={!undoEntry || historyBusy || saving}
                  onClick={() => void undo()}
                  title={undoEntry ? `撤销：${undoEntry.label}` : "没有可撤销的操作"}
                  aria-label="撤销"
                >
                  <Undo2 className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="size-8"
                  disabled={!redoEntry || historyBusy || saving}
                  onClick={() => void redo()}
                  title={redoEntry ? `重做：${redoEntry.label}` : "没有可重做的操作"}
                  aria-label="重做"
                >
                  <Redo2 className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          {isWeekly && (
            <div className="w-[160px]">
              <label className="mb-1 block text-[11px] font-medium text-muted-foreground">视图</label>
              <Select
                value={selectedViewId}
                onChange={(e) => applySavedView(e.target.value)}
                className="h-8 text-xs"
              >
                <option value={CURRENT_VIEW_ID}>当前筛选</option>
                {savedViews.map((view) => (
                  <option key={view.id} value={view.id}>{view.name}</option>
                ))}
              </Select>
            </div>
          )}
          <div className="flex-1 min-w-[160px]">
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
              <Search className="mr-1 inline size-3" /> {isWeekly ? "事项ID/事项名称/任务名称/负责人" : "事项名称/负责人"}
            </label>
            <Input
              value={keyword}
              onChange={(e) => {
                markCustomView();
                setKeyword(e.target.value);
              }}
              placeholder="请输入关键词"
              className="h-8 text-xs"
            />
          </div>
          <div className="w-[180px]">
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">项目</label>
            <Select
              value={projectFilter}
              onChange={(e) => {
                markCustomView();
                setProjectFilter(e.target.value);
              }}
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
              onChange={(e) => {
                markCustomView();
                setStatusFilter(e.target.value as ItemStatus | "ALL");
              }}
              className="h-8 text-xs"
            >
              <option value="ALL">全部</option>
              {ITEM_STATUS_VALUES.map((s) => (
                <option key={s} value={s}>{ITEM_STATUS_LABEL[s]}</option>
              ))}
            </Select>
          </div>
          <div className="w-[120px]">
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">健康</label>
            <Select
              value={healthFilter}
              onChange={(e) => {
                markCustomView();
                setHealthFilter(e.target.value as ItemHealth | "ALL");
              }}
              className="h-8 text-xs"
            >
              <option value="ALL">全部</option>
              {Object.values(ItemHealth).map((s) => (
                <option key={s} value={s}>{ITEM_HEALTH_LABEL[s]}</option>
              ))}
            </Select>
          </div>
          {isWeekly && (
            <div className="w-[140px]">
              <label className="mb-1 block text-[11px] font-medium text-muted-foreground">视图名称</label>
              <Input
                value={viewName}
                onChange={(e) => setViewName(e.target.value)}
                placeholder="如：我的待办"
                className="h-8 text-xs"
              />
            </div>
          )}
          <div className="flex gap-2">
            {isWeekly && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={saveCurrentView}
                >
                  <Save className="size-3" /> 保存视图
                </Button>
                {selectedViewId !== CURRENT_VIEW_ID && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={deleteCurrentView}
                  >
                    <Trash2 className="size-3" /> 删除视图
                  </Button>
                )}
              </>
            )}
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
            {reordering && <span className="self-center text-xs text-muted-foreground">排序保存中...</span>}
            {deletingSelected && <span className="self-center text-xs text-muted-foreground">删除中...</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table onContextMenu={(event) => openContextMenu(event, itemContextActions())}>
              <TableHeader>
                <TableRow>
                  <TableHead
                    className={`${FROZEN_HEADER_CLASS} w-[64px] min-w-[64px] max-w-[64px] whitespace-nowrap`}
                    style={{ left: sequenceColumnLeft }}
                  >
                    序号
                  </TableHead>
                  {isWeekly && (
                    <TableHead
                      className={`${FROZEN_HEADER_CLASS} w-[120px] min-w-[120px] max-w-[120px] whitespace-nowrap`}
                      style={{ left: matterCodeColumnLeft }}
                    >
                      事项ID
                    </TableHead>
                  )}
                  <TableHead
                    className={`${FROZEN_EDGE_HEADER_CLASS} w-[320px] min-w-[320px] max-w-[320px] whitespace-nowrap`}
                    style={{ left: titleColumnLeft }}
                  >
                    事项名称
                  </TableHead>
                  {isWeekly && <TableHead className="whitespace-nowrap min-w-[140px]">关联任务名称</TableHead>}
                  <TableHead className="whitespace-nowrap min-w-[150px]">责任人</TableHead>
                  <TableHead className="min-w-[88px] whitespace-nowrap">优先级</TableHead>
                  <TableHead className="whitespace-nowrap">计划<br/>开始时间</TableHead>
                  <TableHead className="whitespace-nowrap">计划<br/>结束时间</TableHead>
                  <TableHead className="whitespace-nowrap">实际<br/>开始时间</TableHead>
                  <TableHead className="whitespace-nowrap">实际<br/>结束时间</TableHead>
                  <TableHead className="whitespace-nowrap">任务偏差</TableHead>
                  <TableHead className="whitespace-nowrap min-w-[90px]">进度</TableHead>
                  <TableHead className="whitespace-nowrap">状态</TableHead>
                  <TableHead className="whitespace-nowrap min-w-[140px]">健康</TableHead>
                  <TableHead className={ITEM_LONG_TEXT_HEADER_CLASS}>当前问题/措施</TableHead>
                  <TableHead className={ITEM_LONG_TEXT_HEADER_CLASS}>依赖条件</TableHead>
                  <TableHead className="w-[220px] min-w-[220px] max-w-[220px] whitespace-nowrap">风险</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {draft && editingId === null && (
                  <TableRow ref={activeEditRowRef} className="group h-8 align-top bg-primary/5" onBlurCapture={(event) => handleDraftBlur(event, "create")}>
                    <TableCell
                      className={`${FROZEN_CELL_CLASS} ${FROZEN_ACTIVE_ROW_BACKGROUND} w-[64px] min-w-[64px] max-w-[64px] text-xs text-muted-foreground`}
                      style={{ left: sequenceColumnLeft }}
                    >
                      -
                    </TableCell>
                    {isWeekly && (
                      <TableCell
                        className={`${FROZEN_CELL_CLASS} ${FROZEN_ACTIVE_ROW_BACKGROUND} w-[120px] min-w-[120px] max-w-[120px] whitespace-nowrap`}
                        style={{ left: matterCodeColumnLeft }}
                      >
                        <span className="font-mono text-[11px] font-semibold text-muted-foreground">
                          保存后生成
                        </span>
                      </TableCell>
                    )}
                    <TableCell
                      className={`${FROZEN_EDGE_CELL_CLASS} ${FROZEN_TRANSPARENT_ROW_BACKGROUND} w-[320px] min-w-[320px] max-w-[320px]`}
                      style={{ left: titleColumnLeft }}
                    >
                      <div className="flex min-w-0 flex-col gap-1">
                        <Input
                          value={draft.title}
                          onChange={(e) => updateDraft("title", e.target.value)}
                          onKeyDown={handleCreateKeyDown}
                          className={cn(INLINE_INPUT_CLASS, validationErrors.includes("title") && "border-destructive ring-1 ring-destructive/30")}
                          placeholder="事项名称"
                          autoFocus
                        />
                        {validationErrors.includes("title") && <span className="text-[10px] text-destructive">请填写事项名称</span>}
                        <Textarea
                          value={draft.description}
                          onChange={(e) => updateDraft("description", e.target.value)}
                          onKeyDown={handleCreateKeyDown}
                          className={INLINE_TEXTAREA_CLASS}
                          placeholder="事项描述"
                        />
                      </div>
                    </TableCell>
                    {isWeekly && (
                      <TableCell className="text-xs">
                        <HierarchicalMultiSelect
                          options={taskSelectOptions}
                          value={draft.ganttTaskIds ?? []}
                          onChange={(ids) => updateDraft("ganttTaskIds", ids)}
                          multiple
                          applyOnClose
                          placeholder="不关联"
                          searchPlaceholder="搜索任务 ID、名称或类别"
                          ariaLabel="关联任务"
                          className={INLINE_SELECT_CLASS}
                          portalContainer={typeof document === "undefined" ? null : document.body}
                        />
                      </TableCell>
                    )}
                    <TableCell className="text-xs min-w-[150px]">
                      <Select
                        value={draft.owner}
                        onChange={(e) => updateDraft("owner", e.target.value)}
                        onKeyDown={handleCreateKeyDown}
                        className={cn(`${INLINE_SELECT_CLASS} w-[150px]`, validationErrors.includes("owner") && "border-destructive ring-1 ring-destructive/30")}
                      >
                        <option value="">请选择责任人</option>
                        {getOwnerOptions(draft.projectId, draft.owner).map((ownerOption) => (
                          <option key={ownerOption.personName} value={ownerOption.personName}>
                            {ownerOption.label}
                          </option>
                        ))}
                      </Select>
                      {validationErrors.includes("owner") && <span className="mt-1 block text-[10px] text-destructive">请选择责任人</span>}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={draft.priority}
                        onChange={(e) => updateDraft("priority", e.target.value as ItemPriority)}
                        onKeyDown={handleCreateKeyDown}
                        className={PRIORITY_SELECT_CLASS}
                      >
                        {Object.values(ItemPriority).map((priority) => (
                          <option key={priority} value={priority}>{ITEM_PRIORITY_LABEL[priority]}</option>
                        ))}
                      </Select>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      <Input
                        type="date"
                        value={formatDateInput(draft.plannedStartDate)}
                        onChange={(e) => updateDraft("plannedStartDate", e.target.value)}
                        onKeyDown={handleCreateKeyDown}
                        className={`${INLINE_INPUT_CLASS} w-[122px]`}
                      />
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      <Input
                        type="date"
                        value={formatDateInput(draft.plannedEndDate)}
                        onChange={(e) => {
                          updateDraft("plannedEndDate", e.target.value);
                          updateDraft("dueDate", e.target.value);
                        }}
                        onKeyDown={handleCreateKeyDown}
                        className={`${INLINE_INPUT_CLASS} w-[122px]`}
                      />
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      <Input
                        type="date"
                        value={formatDateInput(draft.actualStartDate)}
                        onChange={(e) => updateDraft("actualStartDate", e.target.value)}
                        onKeyDown={handleCreateKeyDown}
                        className={`${INLINE_INPUT_CLASS} w-[122px]`}
                      />
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      <Input
                        type="date"
                        value={formatDateInput(draft.actualEndDate)}
                        onChange={(e) => updateDraft("actualEndDate", e.target.value)}
                        onKeyDown={handleCreateKeyDown}
                        className={`${INLINE_INPUT_CLASS} w-[122px]`}
                      />
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">-</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          value={itemProgressInputValue(draft.progress)}
                          onChange={(e) => updateDraftProgress(Math.min(100, Math.max(0, Number.parseInt(e.target.value, 10) || 0)))}
                          onKeyDown={handleCreateKeyDown}
                          className={cn(`${INLINE_INPUT_CLASS} w-[64px]`, validationErrors.includes("progress") && "border-destructive ring-1 ring-destructive/30")}
                        />
                        <span className="text-[10px] text-muted-foreground">%</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <ItemStatusReadout progress={draft.progress} className="h-7 w-[88px]" />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={draft.health}
                        onChange={(e) => updateDraft("health", e.target.value as ItemHealth)}
                        onKeyDown={handleCreateKeyDown}
                        className={`${INLINE_SELECT_CLASS} w-[88px]`}
                      >
                        {Object.values(ItemHealth).map((health) => (
                          <option key={health} value={health}>{ITEM_HEALTH_LABEL[health]}</option>
                        ))}
                      </Select>
                    </TableCell>
                    <TableCell className={ITEM_LONG_TEXT_CELL_CLASS}>
                      <Textarea
                        value={draft.issueAndAction}
                        onChange={(e) => updateDraft("issueAndAction", e.target.value)}
                        onKeyDown={handleCreateKeyDown}
                        className={ITEM_LONG_TEXT_EDITOR_CLASS}
                      />
                    </TableCell>
                    <TableCell className={ITEM_LONG_TEXT_CELL_CLASS}>
                      <Textarea
                        value={draft.dependency}
                        onChange={(e) => updateDraft("dependency", e.target.value)}
                        onKeyDown={handleCreateKeyDown}
                        className={ITEM_LONG_TEXT_EDITOR_CLASS}
                      />
                    </TableCell>
                    <TableCell className="w-[220px] min-w-[220px] max-w-[220px] overflow-hidden text-[11px] text-muted-foreground">
                      由风险登记册关联
                    </TableCell>
                  </TableRow>
                )}
                {sorted.map((item, index) => {
                  const editing = editingId === item.id && draft?.id === item.id;
                  const row = editing && draft ? draft : item;
                  const startDev = diffDays(row.plannedStartDate, row.actualStartDate);
                  const endDev = diffDays(row.plannedEndDate, row.actualEndDate);
                  const showDev = startDev !== null || endDev !== null;
                  const devText = (n: number | null) =>
                    n === null ? null : n === 0 ? "0" : n > 0 ? `+${n}天` : `${n}天`;
                  const isEditingField = (field: EditableField) => editing && editingField === field;
                  const frozenRowBackground = editing ? FROZEN_ACTIVE_ROW_BACKGROUND : frozenDataRowBackground();
                  return (
                    <TableRow
                      key={item.id}
                      ref={editing ? activeEditRowRef : undefined}
                      data-table-row-id={item.id}
                      draggable={canEdit && !editing && !saving}
                      onDragStart={(event) => {
                        if (!canEdit || editing) return;
                        setDraggedItemId(item.id);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", item.id);
                      }}
                      onDragOver={(event) => {
                        if (!draggedItemId || draggedItemId === item.id) return;
                        event.preventDefault();
                        setItemDropTarget({ id: item.id, position: getDropPosition(event) });
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        void reorderItems(item.id, itemDropTarget?.id === item.id ? itemDropTarget.position : "before");
                      }}
                      onDragEnd={() => {
                        setDraggedItemId(null);
                        setItemDropTarget(null);
                      }}
                      onContextMenu={(event) => openItemContextMenu(event, item)}
                      onBlurCapture={editing ? (event) => handleDraftBlur(event, "edit") : undefined}
                      className={
                        editing
                          ? "group h-8 align-top bg-primary/5"
                          : canEdit
                            ? [
                                "group h-8 cursor-grab align-top transition-[background,box-shadow,transform] duration-150 active:cursor-grabbing",
                                "bg-transparent",
                                "hover:bg-primary/5",
                                selectedIds.includes(item.id) ? "bg-primary/10 ring-1 ring-inset ring-primary/35" : "",
                                draggedItemId === item.id ? "scale-[0.995] opacity-45 shadow-lg" : "",
                                itemDropTarget?.id === item.id && draggedItemId !== item.id && itemDropTarget.position === "before"
                                  ? "translate-y-1 bg-primary/10 shadow-[inset_0_6px_0_hsl(var(--primary)/0.16),inset_0_2px_0_hsl(var(--primary))]"
                                  : "",
                                itemDropTarget?.id === item.id && draggedItemId !== item.id && itemDropTarget.position === "after"
                                  ? "-translate-y-1 bg-primary/10 shadow-[inset_0_-6px_0_hsl(var(--primary)/0.16),inset_0_-2px_0_hsl(var(--primary))]"
                                  : "",
                              ].filter(Boolean).join(" ")
                            : [
                                "group h-8 align-top",
                                "bg-transparent",
                              ].join(" ")
                      }
                    >
                      <TableCell
                        className={cn(
                          FROZEN_CELL_CLASS,
                          frozenRowBackground,
                          "w-[64px] min-w-[64px] max-w-[64px] cursor-pointer select-none text-xs tabular-nums text-muted-foreground",
                          selectedIds.includes(item.id) && "!bg-primary/15 font-semibold text-primary",
                        )}
                        style={{ left: sequenceColumnLeft }}
                        onClick={(event) => {
                          event.stopPropagation();
                          selectFromSequence(item.id, event);
                        }}
                        title="单击选择；Ctrl/Cmd 多选；Shift 连选"
                      >
                        {index + 1}
                      </TableCell>
                      {isWeekly && (
                        <TableCell
                          className={`${FROZEN_CELL_CLASS} ${frozenRowBackground} w-[120px] min-w-[120px] max-w-[120px] whitespace-nowrap`}
                          style={{ left: matterCodeColumnLeft }}
                        >
                          <span className="font-mono text-[11px] font-semibold text-muted-foreground">
                            {row.matterCode || "-"}
                          </span>
                        </TableCell>
                      )}
                      <TableCell
                        className={`${FROZEN_EDGE_CELL_CLASS} ${FROZEN_TRANSPARENT_ROW_BACKGROUND} w-[320px] min-w-[320px] max-w-[320px]`}
                        style={{ left: titleColumnLeft }}
                      >
                        {isEditingField("title") ? (
                          <div className="min-w-0">
                            <Input
                              value={row.title}
                              onChange={(e) => updateDraft("title", e.target.value)}
                              onKeyDown={handleEditKeyDown}
                              className={cn(INLINE_INPUT_CLASS, validationErrors.includes("title") && "border-destructive ring-1 ring-destructive/30")}
                              placeholder="事项名称"
                              autoFocus
                            />
                            {validationErrors.includes("title") && <span className="mt-1 block text-[10px] text-destructive">请填写事项名称</span>}
                          </div>
                        ) : isEditingField("description") ? (
                          <div className="min-w-[220px]">
                            <Textarea
                              value={row.description}
                              onChange={(e) => updateDraft("description", e.target.value)}
                              onKeyDown={handleEditKeyDown}
                              className={INLINE_TEXTAREA_CLASS}
                              placeholder="事项描述"
                              autoFocus
                            />
                          </div>
                        ) : (
                          <>
                            <div
                              className={cn(
                                canEdit ? "cursor-pointer rounded px-1 py-0.5 font-medium text-xs leading-tight hover:bg-primary/10" : "font-medium text-xs leading-tight",
                                item.progress >= 100 && "text-muted-foreground line-through",
                              )}
                              {...editTriggerProps(item, "title")}
                            >
                              {item.title}
                            </div>
                            <div
                              className={canEdit ? "cursor-pointer rounded px-1 py-0.5 text-[10px] text-muted-foreground line-clamp-1 hover:bg-primary/10" : "text-[10px] text-muted-foreground line-clamp-1"}
                              {...editTriggerProps(item, "description")}
                              title={item.description || "填写详细事件内容"}
                            >
                              {item.description || "-"}
                            </div>
                          </>
                        )}
                      </TableCell>
                      {isWeekly && (
                        <TableCell>
                          <HierarchicalMultiSelect
                            options={taskSelectOptions}
                            value={item.ganttTaskIds ?? []}
                            onChange={(ids) => void commitSelectChange("ganttTaskIds", ids, item)}
                            multiple
                            applyOnClose
                            disabled={!canEdit}
                            placeholder="不关联"
                            searchPlaceholder="搜索任务 ID、名称或类别"
                            ariaLabel="关联任务"
                            className={`${GHOST_SELECT_CLASS} min-w-[180px] !border-transparent !bg-transparent hover:!border-transparent hover:!bg-transparent focus-visible:!border-transparent focus-visible:!bg-transparent`}
                            portalContainer={typeof document === "undefined" ? null : document.body}
                          />
                        </TableCell>
                      )}
                      <TableCell className="text-xs min-w-[150px]">
                        <Select
                          variant="ghost"
                          value={item.owner}
                          onChange={(e) => commitSelectChange("owner", e.target.value, item)}
                          className={`${GHOST_SELECT_CLASS} w-[150px]`}
                          disabled={!canEdit}
                        >
                          {getOwnerOptions(item.projectId, item.owner).map((ownerOption) => (
                            <option key={ownerOption.personName} value={ownerOption.personName}>
                              {ownerOption.label}
                            </option>
                          ))}
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          variant="ghost"
                          value={item.priority}
                          onChange={(e) => commitSelectChange("priority", e.target.value as ItemPriority, item)}
                          className={cn(GHOST_SELECT_CLASS, "!w-[88px] !min-w-[88px] !max-w-[88px]")}
                        >
                          {Object.values(ItemPriority).map((priority) => (
                            <option key={priority} value={priority}>{ITEM_PRIORITY_LABEL[priority]}</option>
                          ))}
                      </Select>
                    </TableCell>
                    <TableCell className={canEdit ? "cursor-pointer text-xs whitespace-nowrap hover:bg-primary/5" : "text-xs whitespace-nowrap"} {...editTriggerProps(item, "plannedStartDate")}>
                      {isEditingField("plannedStartDate") ? (
                          <Input
                            type="date"
                            value={formatDateInput(row.plannedStartDate)}
                            onChange={(e) => updateDraft("plannedStartDate", e.target.value)}
                            onKeyDown={handleEditKeyDown}
                            className={`${INLINE_INPUT_CLASS} w-[122px]`}
                            autoFocus
                          />
                        ) : DATE_CELL(item.plannedStartDate)}
                      </TableCell>
                      <TableCell className={canEdit ? "cursor-pointer text-xs whitespace-nowrap hover:bg-primary/5" : "text-xs whitespace-nowrap"} {...editTriggerProps(item, "plannedEndDate")}>
                        {isEditingField("plannedEndDate") ? (
                          <Input
                            type="date"
                            value={formatDateInput(row.plannedEndDate)}
                            onChange={(e) => {
                              updateDraft("plannedEndDate", e.target.value);
                              updateDraft("dueDate", e.target.value);
                            }}
                            onKeyDown={handleEditKeyDown}
                            className={`${INLINE_INPUT_CLASS} w-[122px]`}
                            autoFocus
                          />
                        ) : DATE_CELL(item.plannedEndDate)}
                      </TableCell>
                      <TableCell className={canEdit ? "cursor-pointer text-xs whitespace-nowrap hover:bg-primary/5" : "text-xs whitespace-nowrap"} {...editTriggerProps(item, "actualStartDate")}>
                        {isEditingField("actualStartDate") ? (
                          <Input
                            type="date"
                            value={formatDateInput(row.actualStartDate)}
                            onChange={(e) => updateDraft("actualStartDate", e.target.value)}
                            onKeyDown={handleEditKeyDown}
                            className={`${INLINE_INPUT_CLASS} w-[122px]`}
                            autoFocus
                          />
                        ) : DATE_CELL(item.actualStartDate)}
                      </TableCell>
                      <TableCell className={canEdit ? "cursor-pointer text-xs whitespace-nowrap hover:bg-primary/5" : "text-xs whitespace-nowrap"} {...editTriggerProps(item, "actualEndDate")}>
                        {isEditingField("actualEndDate") ? (
                          <Input
                            type="date"
                            value={formatDateInput(row.actualEndDate)}
                            onChange={(e) => updateDraft("actualEndDate", e.target.value)}
                            onKeyDown={handleEditKeyDown}
                            className={`${INLINE_INPUT_CLASS} w-[122px]`}
                            autoFocus
                          />
                        ) : DATE_CELL(item.actualEndDate)}
                      </TableCell>
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
                      <TableCell className={canEdit ? "cursor-pointer hover:bg-primary/5" : undefined} {...editTriggerProps(item, "progress")}>
                        {isEditingField("progress") ? (
                          <div className="flex items-center gap-1">
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              value={itemProgressInputValue(row.progress)}
                              onChange={(e) => updateDraftProgress(Math.min(100, Math.max(0, Number.parseInt(e.target.value, 10) || 0)))}
                              onKeyDown={handleEditKeyDown}
                              className={cn(`${INLINE_INPUT_CLASS} w-[64px]`, validationErrors.includes("progress") && "border-destructive ring-1 ring-destructive/30")}
                              autoFocus
                            />
                            <span className="text-[10px] text-muted-foreground">%</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1">
                            <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                              <div
                                className={`h-full ${PROGRESS_BAR_COLOR(item.progress)}`}
                                style={{ width: `${Math.min(100, Math.max(0, item.progress))}%` }}
                              />
                            </div>
                            <span className="text-[10px] text-muted-foreground tabular-nums">{item.progress}%</span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <ItemStatusReadout
                          progress={row.progress}
                          className="h-7 w-[92px] border-0 bg-transparent"
                        />
                      </TableCell>
                      <TableCell>
                        <Select
                          variant="ghost"
                          value={item.health}
                          onChange={(e) => commitSelectChange("health", e.target.value as ItemHealth, item)}
                          className={`${GHOST_SELECT_CLASS} w-[92px]`}
                        >
                          {Object.values(ItemHealth).map((health) => (
                            <option key={health} value={health}>{ITEM_HEALTH_LABEL[health]}</option>
                          ))}
                        </Select>
                      </TableCell>
                      <TableCell className={cn(ITEM_LONG_TEXT_CELL_CLASS, canEdit && "cursor-pointer hover:bg-primary/5")} {...editTriggerProps(item, "issueAndAction")}>
                        {isEditingField("issueAndAction") ? (
                          <Textarea
                            value={row.issueAndAction}
                            onChange={(e) => updateDraft("issueAndAction", e.target.value)}
                            onKeyDown={handleEditKeyDown}
                            className={ITEM_LONG_TEXT_EDITOR_CLASS}
                            autoFocus
                          />
                        ) : (
                          <div className="line-clamp-2 min-w-0 break-words text-[10px] leading-4 [overflow-wrap:anywhere]" title={item.issueAndAction || undefined}>
                            {item.issueAndAction || "-"}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className={cn(ITEM_LONG_TEXT_CELL_CLASS, canEdit && "cursor-pointer hover:bg-primary/5")} {...editTriggerProps(item, "dependency")}>
                        {isEditingField("dependency") ? (
                          <Textarea
                            value={row.dependency}
                            onChange={(e) => updateDraft("dependency", e.target.value)}
                            onKeyDown={handleEditKeyDown}
                            className={ITEM_LONG_TEXT_EDITOR_CLASS}
                            autoFocus
                          />
                        ) : (
                          <div className="line-clamp-2 min-w-0 break-words text-[10px] leading-4 [overflow-wrap:anywhere]" title={item.dependency || undefined}>
                            {item.dependency || "-"}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="w-[220px] min-w-[220px] max-w-[220px] overflow-hidden text-[11px]">
                        {(item.linkedRisks ?? []).length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {item.linkedRisks.map((risk) => (
                              <button
                                key={risk.id}
                                type="button"
                                draggable={false}
                                className="inline-flex max-w-full items-center gap-1 rounded border border-border/70 bg-background/45 px-1.5 py-0.5 text-left text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/[0.07] hover:text-foreground"
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedRisk(risk);
                                }}
                                title={`查看 ${risk.riskCode} 风险详情`}
                              >
                                <span className="shrink-0 font-mono font-semibold text-primary">{risk.riskCode}</span>
                                <span className="truncate">{risk.riskName}</span>
                              </button>
                            ))}
                          </div>
                        ) : "-"}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {sorted.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={tableColSpan} className="h-32 text-center text-sm text-muted-foreground">
                      {items.length === 0
                            ? `暂无${title}数据。${
                            canCreate
                              ? currentProjectId
                                ? "在表格中右击即可新增。"
                                : "请先到「项目列表」选择当前项目后再新增。"
                              : ""
                          }`
                        : "无匹配事项"}
                    </TableCell>
                  </TableRow>
                )}
                {loading && (
                  <TableRow>
                    <TableCell colSpan={tableColSpan} className="h-24 text-center text-sm text-muted-foreground">
                      加载中...
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <TableContextMenu menu={menu} onClose={closeContextMenu} />
          </div>
        </CardContent>
      </Card>

      <Dialog open={Boolean(selectedRisk)} onOpenChange={(open) => { if (!open) setSelectedRisk(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 font-mono text-sm text-primary">{selectedRisk?.riskCode}</span>
              <span className="truncate">{selectedRisk?.riskName || "风险详情"}</span>
            </DialogTitle>
            <DialogDescription>该信息由风险登记册维护，项目事项中仅供查看。</DialogDescription>
          </DialogHeader>
          {selectedRisk && (
            <div className="grid gap-x-5 md:grid-cols-2">
              <RiskDetailField label="风险ID" value={selectedRisk.riskCode} />
              <RiskDetailField label="风险名称" value={selectedRisk.riskName} />
              <RiskDetailField label="关联项目事项" value={[selectedRisk.linkedItemCode, selectedRisk.linkedItemName].filter(Boolean).join(" · ")} wide />
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

      {/* Legacy create card replaced by the inline table row above.
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
            {isWeekly && (
              <div className="grid grid-cols-2 gap-3">
                <FormField label="事项ID">
                  <Input value="保存后自动生成" disabled className="h-8 text-xs font-mono" />
                </FormField>
                <FormField label="关联任务名称">
                  <Select
                    value={draft.taskName ?? ""}
                    onChange={(e) => commitSelectChange("taskName", e.target.value)}
                    className="h-8 text-xs"
                  >
                    <option value="">不关联</option>
                    {taskOptions.map((task) => (
                      <option key={task.id} value={task.taskName}>
                        {task.taskCode ? `${task.taskCode} · ${task.taskName}` : task.taskName}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </div>
            )}
            <FormField label="事项名称" required>
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
            <FormField label="截止日期">
              <Input type="date" value={formatDateInput(draft.dueDate)} onChange={(e) => updateDraft("dueDate", e.target.value)} className="h-8 text-xs" />
            </FormField>
            <div className="grid grid-cols-4 gap-3">
              <FormField label="优先级">
                <select
                  value={draft.priority}
                  onChange={(e) => commitSelectChange("priority", e.target.value as ItemPriority)}
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  {Object.values(ItemPriority).map((p) => (
                    <option key={p} value={p}>{ITEM_PRIORITY_LABEL[p]}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="状态">
                <ItemStatusReadout progress={draft.progress} />
              </FormField>
              <FormField label="健康状态">
                <select
                  value={draft.health}
                  onChange={(e) => commitSelectChange("health", e.target.value as ItemHealth)}
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
                  onChange={(e) => commitSelectChange("riskStatus", e.target.value as ItemRiskStatus)}
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
                  onChange={(e) => updateDraftProgress(Number.parseInt(e.target.value, 10))}
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
      */}

      {/* Legacy full-card edit form replaced by inline row editing.
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
            {isWeekly && (
              <div className="grid grid-cols-2 gap-3">
                <FormField label="事项ID">
                  <Input value={draft.matterCode || "-"} disabled className="h-8 text-xs font-mono" />
                </FormField>
                <FormField label="关联任务名称">
                  <Select
                    value={draft.taskName ?? ""}
                    onChange={(e) => commitSelectChange("taskName", e.target.value)}
                    className="h-8 text-xs"
                  >
                    <option value="">不关联</option>
                    {taskOptions.map((task) => (
                      <option key={task.id} value={task.taskName}>
                        {task.taskCode ? `${task.taskCode} · ${task.taskName}` : task.taskName}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </div>
            )}
            <FormField label="事项名称" required>
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
            <FormField label="截止日期">
              <Input type="date" value={formatDateInput(draft.dueDate)} onChange={(e) => updateDraft("dueDate", e.target.value)} className="h-8 text-xs" />
            </FormField>
            <div className="grid grid-cols-4 gap-3">
              <FormField label="优先级">
                <select
                  value={draft.priority}
                  onChange={(e) => commitSelectChange("priority", e.target.value as ItemPriority)}
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  {Object.values(ItemPriority).map((p) => (
                    <option key={p} value={p}>{ITEM_PRIORITY_LABEL[p]}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="状态">
                <ItemStatusReadout progress={draft.progress} />
              </FormField>
              <FormField label="健康状态">
                <select
                  value={draft.health}
                  onChange={(e) => commitSelectChange("health", e.target.value as ItemHealth)}
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
                  onChange={(e) => commitSelectChange("riskStatus", e.target.value as ItemRiskStatus)}
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
                  onChange={(e) => updateDraftProgress(Number.parseInt(e.target.value, 10))}
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
      */}
    </div>
  );
};
