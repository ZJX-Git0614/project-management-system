"use client";

import { KeyboardEvent, type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Plus, Save, Search, Trash2, Upload } from "lucide-react";
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
  taskName?: string;
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

type EditableField =
  | "title"
  | "description"
  | "ganttTaskId"
  | "owner"
  | "priority"
  | "plannedStartDate"
  | "actualStartDate"
  | "plannedEndDate"
  | "actualEndDate"
  | "progress"
  | "status"
  | "health"
  | "issueAndAction"
  | "dependency"
  | "risk";

interface ProjectGanttTaskOption {
  id: string;
  taskName: string;
  taskCode: string;
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
const PRIORITY_SELECT_CLASS = "h-7 !w-[76px] !min-w-[76px] !max-w-[76px] px-2 text-xs";
const INLINE_TEXTAREA_CLASS = "min-h-14 min-w-[160px] resize-y rounded border-border bg-background px-2 py-1 text-xs";
const CURRENT_VIEW_ID = "__current__";
type DropPosition = "before" | "after";

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
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [itemDropTarget, setItemDropTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  const [reordering, setReordering] = useState(false);

  const canView = can(`${kind}-items:view`);
  const canCreate = can(`${kind}-items:create`);
  const canEdit = can(`${kind}-items:edit`) || can("account-management:view");
  const canDelete = can(`${kind}-items:delete`);
  const canExport = can(`${kind}-items:export`);
  const isWeekly = kind === "weekly";
  const tableColSpan = (isWeekly ? 20 : 18) + (selectionMode ? 1 : 0);
  const savedViewStorageKey = `pms.saved-views.item.${kind}`;

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

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
    setStatusFilter(view.statusFilter);
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
      const hitKw = !kw
        || item.title.toLowerCase().includes(kw)
        || item.owner.toLowerCase().includes(kw)
        || (item.matterCode ?? "").toLowerCase().includes(kw)
        || (item.taskName ?? "").toLowerCase().includes(kw);
      const hitProject = projectFilter === "ALL" || item.projectId === projectFilter;
      const hitStatus = statusFilter === "ALL" || item.status === statusFilter;
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
  }, [sorted]);

  const toggleSelectionMode = () => {
    setSelectionMode((prev) => !prev);
    setSelectedIds([]);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => (
      prev.includes(id) ? prev.filter((itemId) => itemId !== id) : [...prev, id]
    ));
  };

  const handleExport = () => {
    const rows = sorted.map((it, index) => {
      const p = projects.find((pp) => pp.id === it.projectId);
      const startDev = diffDays(it.plannedStartDate, it.actualStartDate);
      return [
        String(index + 1),
        ...(isWeekly ? [it.matterCode || "-", it.title, it.taskName || "-"] : [it.title]),
        p ? `${p.name}(${p.code})` : "-",
        it.owner,
        ITEM_PRIORITY_LABEL[it.priority as ItemPriority] ?? it.priority,
        it.plannedStartDate || "-",
        it.plannedEndDate || "-",
        it.actualStartDate || "-",
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

  const openCreate = () => {
    const ownerOptions = getOwnerOptions(currentProjectId ?? undefined);
    const defaultOwner =
      ownerOptions.find((option) => option.personName === user?.displayName)?.personName
      ?? ownerOptions[0]?.personName
      ?? "";
    setEditingId(null);
    setEditingField(null);
    setDraft({
      id: "",
      projectId: currentProjectId ?? "",
      matterCode: "",
      ganttTaskId: null,
      title: "",
      taskName: "",
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
    setDraft({ ...item });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingField(null);
    clearDraft();
  };

  const updateDraft = <K extends keyof ItemRecord>(key: K, value: ItemRecord[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
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
    if (!updated.title.trim() || updated.progress < 0) {
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
      const { id: _id, createdAt: _ca, updatedAt: _ua, project: _p, matterCode: _mc, ...payload } = updated;
      void _id; void _ca; void _ua; void _p; void _mc;
      await api.put(`${apiPath}/${updated.id}`, payload);
      flushSync(() => {
        cancelEdit();
      });
      await fetchData();
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

  const submitCreate = async () => {
    if (!draft) return;
    if (!currentProjectId) {
      alert("请先从项目列表中选择当前项目");
      return;
    }
    if (!draft.title.trim() || draft.progress < 0) {
      alert("请填写事项名称，且进度不能小于 0");
      return;
    }
    setSaving(true);
    try {
      const { id: _id, createdAt: _ca, updatedAt: _ua, project: _p, matterCode: _mc, ...payload } = draft;
      void _id; void _ca; void _ua; void _p; void _mc;
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
    if (!draft.title.trim() || draft.progress < 0) {
      alert("请填写事项名称，且进度不能小于 0");
      return;
    }
    setSaving(true);
    try {
      const { id: _id, createdAt: _ca, updatedAt: _ua, project: _p, matterCode: _mc, ...payload } = draft;
      void _id; void _ca; void _ua; void _p; void _mc;
      await api.put(`${apiPath}/${draft.id}`, payload);
      cancelEdit();
      await fetchData();
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleEditKeyDown = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    if (event.key !== "Enter") return;
    if (event.currentTarget instanceof HTMLTextAreaElement && event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    void submitEdit();
  };

  const handleCreateKeyDown = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    if (event.key !== "Enter") return;
    if (event.currentTarget instanceof HTMLTextAreaElement && event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    void submitCreate();
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

  const handleDeleteSelected = async () => {
    const selectedItems = sorted.filter((item) => selectedIds.includes(item.id));
    if (selectedItems.length === 0) return;
    if (!(await confirm(`确认删除选中的 ${selectedItems.length} 个事项？`))) return;
    setDeletingSelected(true);
    try {
      await Promise.all(selectedItems.map((item) => api.delete(`${apiPath}/${item.id}`)));
      setSelectedIds([]);
      setSelectionMode(false);
      await fetchData();
    } catch (err) {
      alert(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeletingSelected(false);
    }
  };

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
      await api.post("/api/weekly-items/reorder", { itemIds: nextItemIds });
      await fetchData();
    } catch (error) {
      alert(error instanceof Error ? error.message : "排序保存失败");
      await fetchData();
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
                {description} · 时间窗口 {dateRange.start} ~ {dateRange.end}
              </CardDescription>
            </div>
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
              {Object.values(ItemStatus).map((s) => (
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
            {canDelete && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={toggleSelectionMode}
                disabled={deletingSelected}
              >
                {selectionMode ? "取消选择" : "选择"}
              </Button>
            )}
            {canDelete && selectionMode && (
              <Button
                variant="destructive"
                size="sm"
                className="h-8 text-xs"
                onClick={() => void handleDeleteSelected()}
                disabled={selectedIds.length === 0 || deletingSelected}
              >
                {deletingSelected ? "删除中..." : `删除 ${selectedIds.length}`}
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
                  {selectionMode && <TableHead className="w-[48px] whitespace-nowrap">选择</TableHead>}
                  <TableHead className="w-[64px] whitespace-nowrap">序号</TableHead>
                  {isWeekly && <TableHead className="whitespace-nowrap">事项ID</TableHead>}
                  <TableHead className="whitespace-nowrap min-w-[200px]">事项名称</TableHead>
                  {isWeekly && <TableHead className="whitespace-nowrap min-w-[140px]">关联任务名称</TableHead>}
                  <TableHead className="whitespace-nowrap min-w-[160px]">归属方</TableHead>
                  <TableHead className="whitespace-nowrap min-w-[150px]">责任人</TableHead>
                  <TableHead className="whitespace-nowrap">优先级</TableHead>
                  <TableHead className="whitespace-nowrap">计划<br/>开始时间</TableHead>
                  <TableHead className="whitespace-nowrap">计划<br/>结束时间</TableHead>
                  <TableHead className="whitespace-nowrap">实际<br/>开始时间</TableHead>
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
                {draft && editingId === null && (
                  <TableRow className="h-8 align-top bg-primary/5">
                    {selectionMode && <TableCell className="text-xs" />}
                    <TableCell className="text-xs text-muted-foreground">-</TableCell>
                    {isWeekly && (
                      <TableCell className="whitespace-nowrap font-mono text-xs font-semibold text-muted-foreground">
                        保存后生成
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="flex min-w-[220px] flex-col gap-1">
                        <Input
                          value={draft.title}
                          onChange={(e) => updateDraft("title", e.target.value)}
                          onKeyDown={handleCreateKeyDown}
                          className={INLINE_INPUT_CLASS}
                          placeholder="事项名称"
                          autoFocus
                        />
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
                        <Select
                          value={draft.ganttTaskId ?? ""}
                          onChange={(e) => updateDraft("ganttTaskId", e.target.value)}
                          onKeyDown={handleCreateKeyDown}
                          className={INLINE_SELECT_CLASS}
                        >
                          <option value="">不关联</option>
                          {taskOptions.map((task) => (
                            <option key={task.id} value={task.id}>
                              {task.taskCode ? `${task.taskCode} · ${task.taskName}` : task.taskName}
                            </option>
                          ))}
                        </Select>
                      </TableCell>
                    )}
                    <TableCell className="text-xs">
                      {currentProject ? (
                        <>
                          <div className="font-medium">{currentProject.name}</div>
                          <div className="text-[10px] text-muted-foreground">{currentProject.code}</div>
                        </>
                      ) : "-"}
                    </TableCell>
                    <TableCell className="text-xs min-w-[150px]">
                      <Select
                        value={draft.owner}
                        onChange={(e) => updateDraft("owner", e.target.value)}
                        onKeyDown={handleCreateKeyDown}
                        className={`${INLINE_SELECT_CLASS} w-[150px]`}
                      >
                        <option value="">请选择责任人</option>
                        {getOwnerOptions(draft.projectId, draft.owner).map((ownerOption) => (
                          <option key={ownerOption.personName} value={ownerOption.personName}>
                            {ownerOption.label}
                          </option>
                        ))}
                      </Select>
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
                          value={draft.progress}
                          onChange={(e) => updateDraft("progress", Math.min(100, Math.max(0, Number.parseInt(e.target.value, 10) || 0)))}
                          onKeyDown={handleCreateKeyDown}
                          className={`${INLINE_INPUT_CLASS} w-[64px]`}
                        />
                        <span className="text-[10px] text-muted-foreground">%</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={draft.status}
                        onChange={(e) => updateDraft("status", e.target.value as ItemStatus)}
                        onKeyDown={handleCreateKeyDown}
                        className={`${INLINE_SELECT_CLASS} w-[88px]`}
                      >
                        {Object.values(ItemStatus).map((status) => (
                          <option key={status} value={status}>{ITEM_STATUS_LABEL[status]}</option>
                        ))}
                      </Select>
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
                    <TableCell className="text-xs whitespace-pre-wrap break-words max-w-[200px]">
                      <Textarea
                        value={draft.issueAndAction}
                        onChange={(e) => updateDraft("issueAndAction", e.target.value)}
                        onKeyDown={handleCreateKeyDown}
                        className={INLINE_TEXTAREA_CLASS}
                      />
                    </TableCell>
                    <TableCell className="text-xs whitespace-pre-wrap break-words max-w-[160px]">
                      <Textarea
                        value={draft.dependency}
                        onChange={(e) => updateDraft("dependency", e.target.value)}
                        onKeyDown={handleCreateKeyDown}
                        className={INLINE_TEXTAREA_CLASS}
                      />
                    </TableCell>
                    <TableCell className="text-xs whitespace-pre-wrap break-words max-w-[160px]">
                      <Textarea
                        value={draft.risk}
                        onChange={(e) => updateDraft("risk", e.target.value)}
                        onKeyDown={handleCreateKeyDown}
                        className={INLINE_TEXTAREA_CLASS}
                      />
                    </TableCell>
                    <TableCell className="sticky right-0 bg-card">
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={(event) => {
                            event.stopPropagation();
                            void submitCreate();
                          }}
                          disabled={saving}
                        >
                          {saving ? "保存中..." : "保存"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={(event) => {
                            event.stopPropagation();
                            cancelEdit();
                          }}
                          disabled={saving}
                        >
                          取消
                        </Button>
                      </div>
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
                  return (
                    <TableRow
                      key={item.id}
                      draggable={canEdit && !selectionMode && !editing && !saving}
                      onDragStart={(event) => {
                        if (!canEdit || selectionMode || editing) return;
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
                      className={
                        editing
                          ? "h-8 align-top bg-primary/5"
                          : canEdit
                            ? [
                                "h-8 cursor-grab align-top transition-[background,box-shadow,transform] duration-150 active:cursor-grabbing",
                                index % 2 === 0 ? "bg-background" : "bg-muted/20",
                                "hover:bg-primary/5",
                                draggedItemId === item.id ? "scale-[0.995] opacity-45 shadow-lg" : "",
                                itemDropTarget?.id === item.id && draggedItemId !== item.id && itemDropTarget.position === "before"
                                  ? "translate-y-1 bg-primary/10 shadow-[inset_0_6px_0_hsl(var(--primary)/0.16),inset_0_2px_0_hsl(var(--primary))]"
                                  : "",
                                itemDropTarget?.id === item.id && draggedItemId !== item.id && itemDropTarget.position === "after"
                                  ? "-translate-y-1 bg-primary/10 shadow-[inset_0_-6px_0_hsl(var(--primary)/0.16),inset_0_-2px_0_hsl(var(--primary))]"
                                  : "",
                              ].filter(Boolean).join(" ")
                            : [
                                "h-8 align-top",
                                index % 2 === 0 ? "bg-background" : "bg-muted/20",
                              ].join(" ")
                      }
                    >
                      {selectionMode && (
                        <TableCell className="text-xs">
                          <input
                            type="checkbox"
                            checked={selectedIds.includes(item.id)}
                            onChange={() => toggleSelected(item.id)}
                            onClick={(event) => event.stopPropagation()}
                            className="h-3.5 w-3.5 rounded border-border bg-background"
                          />
                        </TableCell>
                      )}
                      <TableCell className="text-xs tabular-nums text-muted-foreground">{index + 1}</TableCell>
                      {isWeekly && (
                        <TableCell className="whitespace-nowrap font-mono text-xs font-semibold text-muted-foreground">
                          {row.matterCode || "-"}
                        </TableCell>
                      )}
                      <TableCell>
                        {isEditingField("title") ? (
                          <div className="min-w-[220px]">
                            <Input
                              value={row.title}
                              onChange={(e) => updateDraft("title", e.target.value)}
                              onKeyDown={handleEditKeyDown}
                              className={INLINE_INPUT_CLASS}
                              placeholder="事项名称"
                              autoFocus
                            />
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
                              className={canEdit ? "cursor-pointer rounded px-1 py-0.5 font-medium text-xs leading-tight hover:bg-primary/10" : "font-medium text-xs leading-tight"}
                              {...editTriggerProps(item, "title")}
                            >
                              {item.title}
                            </div>
                            {item.description && (
                              <div
                                className={canEdit ? "cursor-pointer rounded px-1 py-0.5 text-[10px] text-muted-foreground line-clamp-1 hover:bg-primary/10" : "text-[10px] text-muted-foreground line-clamp-1"}
                                {...editTriggerProps(item, "description")}
                              >
                                {item.description}
                              </div>
                            )}
                          </>
                        )}
                      </TableCell>
                      {isWeekly && (
                        <TableCell>
                          <Select
                            variant="ghost"
                            value={item.ganttTaskId ?? ""}
                            onChange={(e) => commitSelectChange("ganttTaskId", e.target.value, item)}
                            className={`${GHOST_SELECT_CLASS} min-w-[180px]`}
                          >
                            <option value="">不关联</option>
                            {taskOptions.map((task) => (
                              <option key={task.id} value={task.id}>
                                {task.taskCode ? `${task.taskCode} · ${task.taskName}` : task.taskName}
                              </option>
                            ))}
                          </Select>
                        </TableCell>
                      )}
                      <TableCell className="text-xs">
                        {item.project ? (
                          <>
                            <div className="font-medium">{item.project.name}</div>
                            <div className="text-[10px] text-muted-foreground">{item.project.code}</div>
                          </>
                        ) : "-"}
                      </TableCell>
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
                          className={cn(GHOST_SELECT_CLASS, "!w-[76px] !min-w-[76px] !max-w-[76px]")}
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
                              value={row.progress}
                              onChange={(e) => updateDraft("progress", Math.min(100, Math.max(0, Number.parseInt(e.target.value, 10) || 0)))}
                              onKeyDown={handleEditKeyDown}
                              className={`${INLINE_INPUT_CLASS} w-[64px]`}
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
                        <Select
                          variant="ghost"
                          value={item.status}
                          onChange={(e) => commitSelectChange("status", e.target.value as ItemStatus, item)}
                          className={`${GHOST_SELECT_CLASS} w-[92px]`}
                        >
                          {Object.values(ItemStatus).map((status) => (
                            <option key={status} value={status}>{ITEM_STATUS_LABEL[status]}</option>
                          ))}
                        </Select>
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
                      <TableCell className={canEdit ? "cursor-pointer text-xs whitespace-pre-wrap break-words max-w-[200px] hover:bg-primary/5" : "text-xs whitespace-pre-wrap break-words max-w-[200px]"} {...editTriggerProps(item, "issueAndAction")}>
                        {isEditingField("issueAndAction") ? (
                          <Textarea
                            value={row.issueAndAction}
                            onChange={(e) => updateDraft("issueAndAction", e.target.value)}
                            onKeyDown={handleEditKeyDown}
                            className={INLINE_TEXTAREA_CLASS}
                            autoFocus
                          />
                        ) : item.issueAndAction || "-"}
                      </TableCell>
                      <TableCell className={canEdit ? "cursor-pointer text-xs whitespace-pre-wrap break-words max-w-[160px] hover:bg-primary/5" : "text-xs whitespace-pre-wrap break-words max-w-[160px]"} {...editTriggerProps(item, "dependency")}>
                        {isEditingField("dependency") ? (
                          <Textarea
                            value={row.dependency}
                            onChange={(e) => updateDraft("dependency", e.target.value)}
                            onKeyDown={handleEditKeyDown}
                            className={INLINE_TEXTAREA_CLASS}
                            autoFocus
                          />
                        ) : item.dependency || "-"}
                      </TableCell>
                      <TableCell className={canEdit ? "cursor-pointer text-xs whitespace-pre-wrap break-words max-w-[160px] hover:bg-primary/5" : "text-xs whitespace-pre-wrap break-words max-w-[160px]"} {...editTriggerProps(item, "risk")}>
                        {isEditingField("risk") ? (
                          <Textarea
                            value={row.risk}
                            onChange={(e) => updateDraft("risk", e.target.value)}
                            onKeyDown={handleEditKeyDown}
                            className={INLINE_TEXTAREA_CLASS}
                            autoFocus
                          />
                        ) : item.risk || "-"}
                      </TableCell>
                      <TableCell className="sticky right-0 bg-card">
                        <div className="flex items-center gap-1">
                          {editing ? (
                            <>
                              <Button
                                size="sm"
                                className="h-7 text-xs"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void submitEdit();
                                }}
                                disabled={saving}
                              >
                                {saving ? "保存中..." : "保存"}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  cancelEdit();
                                }}
                                disabled={saving}
                              >
                                取消
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {sorted.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={tableColSpan} className="h-32 text-center text-sm text-muted-foreground">
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
                    <TableCell colSpan={tableColSpan} className="h-24 text-center text-sm text-muted-foreground">
                      加载中...
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

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
                <select
                  value={draft.status}
                  onChange={(e) => commitSelectChange("status", e.target.value as ItemStatus)}
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
                <select
                  value={draft.status}
                  onChange={(e) => commitSelectChange("status", e.target.value as ItemStatus)}
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
      */}
    </div>
  );
};
