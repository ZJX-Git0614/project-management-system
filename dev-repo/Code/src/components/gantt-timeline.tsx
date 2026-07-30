"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Columns3, CornerDownRight, GripVertical, IndentDecrease, IndentIncrease, ListChecks, ListTree, Plus, Search, Trash2, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { GanttDateField } from "@/components/gantt-date-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ProjectGanttTask, ProjectMember } from "@/domain/models";
import type { GanttHierarchyDirection } from "@/lib/gantt-hierarchy";
import {
  GANTT_COLUMN_LABELS,
  GANTT_COLUMN_MIN_WIDTHS,
  GANTT_EXPANDED_COLUMN_KEYS,
  GANTT_HIDEABLE_COLUMN_KEYS,
  fitGanttColumnWidth,
  fitGanttColumnWidths,
  ganttColumnsWidth,
  ganttTaskDepths,
  ganttVisibleColumnKeys,
  type GanttColumnKey,
  type GanttColumnWidths,
} from "@/lib/gantt-column-layout";
import {
  addCalendarDays,
  buildGanttDependencyLinks,
  buildGanttRows,
  diffDays,
  getGanttDateRange,
  parseGanttDate,
} from "@/lib/gantt";
import {
  calculateTaskDurationDays,
  calculateTaskFinishDate,
  estimatedHoursForDuration,
  normalizeGanttDurationDays,
  roundGanttHours,
  type GanttCalendarMode,
} from "@/lib/gantt-calendar";
import { cn } from "@/lib/utils";

interface GanttTimelineProps {
  tasks: ProjectGanttTask[];
  projectMembers?: ProjectMember[];
  calendarMode?: GanttCalendarMode;
  showProject?: boolean;
  emptyText?: string;
  canCreate?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  creatingParentId?: string | null;
  savingTaskId?: string | null;
  deletingSelected?: boolean;
  hierarchyChanging?: boolean;
  reordering?: boolean;
  fullScreen?: boolean;
  portalContainer?: HTMLElement | null;
  onCreateTask?: (parentTask?: ProjectGanttTask) => void;
  onUpdateTask?: (task: ProjectGanttTask, draft: GanttTaskDraft) => void | Promise<void>;
  onDeleteSelected?: (taskIds: string[]) => void | Promise<void>;
  onChangeHierarchy?: (taskIds: string[], direction: GanttHierarchyDirection) => void | Promise<void>;
  onReorderTasks?: (taskIds: string[]) => void | Promise<void>;
}

export type GanttTaskDraft = {
  parentId?: string | null;
  ownerMemberId?: string | null;
  taskCategory: string;
  taskName: string;
  taskDescription: string;
  startDate: string;
  endDate: string;
  durationDays: number;
  actualStartDate: string;
  actualEndDate: string;
  estimatedWorkHours: number;
  actualWorkHours: number;
  progress: number;
  predecessorTaskIds: string[];
  remark: string;
};

const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 32;
const BAR_HEIGHT = 10;
const MIN_TIMELINE_WIDTH = 860;
const ZOOM_LEVELS = [1, 3, 8, 20, 60];
const ZOOM_LABELS = ["60天", "30天", "15天", "5天", "1天"];
const DEFAULT_ZOOM_INDEX = 2;
const GANTT_DEPTH_COLORS = [
  { hue: 214, saturation: 66, lightness: 58 },
  { hue: 192, saturation: 58, lightness: 52 },
  { hue: 168, saturation: 48, lightness: 48 },
  { hue: 42, saturation: 62, lightness: 56 },
  { hue: 276, saturation: 48, lightness: 65 },
  { hue: 342, saturation: 52, lightness: 62 },
  { hue: 24, saturation: 58, lightness: 58 },
  { hue: 228, saturation: 48, lightness: 66 },
] as const;
type DropPosition = "before" | "after";

const GanttDividerToggle = ({
  collapsed,
  onToggle,
  className,
  style,
}: {
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
  style?: CSSProperties;
}) => (
  <button
    type="button"
    className={cn(
      "group absolute z-[76] flex h-16 w-6 items-center justify-center !border-0 !bg-transparent p-0 text-muted-foreground/55 !shadow-none outline-none transition-[color,transform] duration-200 hover:!bg-transparent hover:text-primary focus-visible:!bg-transparent focus-visible:text-primary",
      className,
    )}
    style={style}
    onClick={onToggle}
    title={collapsed ? "展开列" : "折叠列"}
    aria-label={collapsed ? "展开列" : "折叠列"}
  >
    {collapsed
      ? <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" strokeWidth={1.8} />
      : <ChevronLeft className="size-4 transition-transform group-hover:-translate-x-0.5" strokeWidth={1.8} />}
  </button>
);

const ColumnVisibilityMenu = ({
  hiddenColumnKeys,
  onShowAll,
  onToggle,
  portalContainer,
}: {
  hiddenColumnKeys: ReadonlySet<GanttColumnKey>;
  onShowAll: () => void;
  onToggle: (key: GanttColumnKey) => void;
  portalContainer?: HTMLElement | null;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2 text-xs"
        aria-label="列设置"
      >
        <Columns3 className="size-3.5" />
        列
        <ChevronDown className="size-3" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent container={portalContainer} align="end" className="w-44">
      <DropdownMenuItem onSelect={onShowAll}>全部显示</DropdownMenuItem>
      <DropdownMenuSeparator />
      {GANTT_HIDEABLE_COLUMN_KEYS.map((key) => (
        <DropdownMenuCheckboxItem
          key={key}
          checked={!hiddenColumnKeys.has(key)}
          onCheckedChange={() => onToggle(key)}
          onSelect={(event) => event.preventDefault()}
        >
          {GANTT_COLUMN_LABELS[key]}
        </DropdownMenuCheckboxItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

const getTickEvery = (dayWidth: number) => {
  if (dayWidth >= 60) return 1;
  if (dayWidth >= 20) return 5;
  if (dayWidth >= 8) return 15;
  if (dayWidth >= 3) return 30;
  return 30;
};

const inlineFieldClass = cn(
  "h-6 w-full min-w-0 rounded px-1.5 text-xs shadow-none transition-colors",
  "!border-transparent !bg-transparent !ring-0 !ring-offset-0",
  "hover:!border-border/50 group-hover:!bg-muted/10",
  "focus:!border-primary/50 focus:!bg-background focus:!ring-1 focus:!ring-primary/20",
  "disabled:cursor-default disabled:opacity-100"
);

const inlineSelectClass = cn(
  "h-6 w-full min-w-0 rounded px-1.5 text-xs shadow-none transition-colors",
  "!border-transparent !bg-transparent !ring-0 !ring-offset-0",
  "hover:!border-border/50 group-hover:!bg-muted/10",
  "focus:!border-primary/50 focus:!bg-background focus:!ring-1 focus:!ring-primary/20",
  "disabled:cursor-default disabled:opacity-100"
);

const durationFieldClass = cn(
  inlineFieldClass,
  "px-1 text-center font-mono tabular-nums"
);

const toTaskDraft = (task: ProjectGanttTask, calendarMode: GanttCalendarMode): GanttTaskDraft => ({
  parentId: task.parentId ?? null,
  ownerMemberId: task.ownerMemberId ?? null,
  taskCategory: task.taskCategory,
  taskName: task.taskName,
  taskDescription: task.taskDescription ?? "",
  startDate: task.startDate,
  endDate: task.finishDate || calculateTaskFinishDate(task.startDate, task.durationDays, calendarMode),
  durationDays: task.durationDays,
  actualStartDate: task.actualStartDate ?? "",
  actualEndDate: task.actualEndDate ?? "",
  estimatedWorkHours: estimatedHoursForDuration(task.durationDays),
  actualWorkHours: roundGanttHours(task.actualWorkHours ?? 0),
  progress: Math.min(100, Math.max(0, task.progress ?? 0)),
  predecessorTaskIds: task.predecessorTaskIds ?? [],
  remark: task.remark ?? "",
});

const taskDraftEquals = (task: ProjectGanttTask, draft: GanttTaskDraft, calendarMode: GanttCalendarMode) => (
  task.taskCategory === draft.taskCategory
    && task.taskName === draft.taskName
    && (task.taskDescription ?? "") === draft.taskDescription
    && task.startDate === draft.startDate
    && (task.finishDate || calculateTaskFinishDate(task.startDate, task.durationDays, calendarMode)) === draft.endDate
    && task.durationDays === draft.durationDays
    && (task.actualStartDate ?? "") === draft.actualStartDate
    && (task.actualEndDate ?? "") === draft.actualEndDate
    && estimatedHoursForDuration(task.durationDays) === draft.estimatedWorkHours
    && roundGanttHours(task.actualWorkHours ?? 0) === draft.actualWorkHours
    && (task.progress ?? 0) === draft.progress
    && JSON.stringify(task.predecessorTaskIds ?? []) === JSON.stringify(draft.predecessorTaskIds)
    && (task.remark ?? "") === draft.remark
    && (task.parentId ?? null) === (draft.parentId ?? null)
    && (task.ownerMemberId ?? null) === (draft.ownerMemberId ?? null)
);

const GanttTimelineContent = ({
  tasks,
  projectMembers = [],
  calendarMode = "CALENDAR_DAYS",
  emptyText = "暂无甘特任务",
  canCreate = false,
  canEdit = false,
  canDelete = false,
  creatingParentId = null,
  savingTaskId = null,
  deletingSelected = false,
  hierarchyChanging = false,
  reordering = false,
  fullScreen = false,
  portalContainer,
  onCreateTask,
  onUpdateTask,
  onDeleteSelected,
  onChangeHierarchy,
  onReorderTasks,
}: GanttTimelineProps) => {
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const dayWidth = ZOOM_LEVELS[zoomIndex];
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [taskDropTarget, setTaskDropTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  const [flashingTaskId, setFlashingTaskId] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<GanttColumnWidths>({ ...GANTT_COLUMN_MIN_WIDTHS });
  const [hiddenColumnKeys, setHiddenColumnKeys] = useState<Set<GanttColumnKey>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const visibleColumnKeys = useMemo(
    () => ganttVisibleColumnKeys(detailsCollapsed, hiddenColumnKeys),
    [detailsCollapsed, hiddenColumnKeys],
  );
  const leftWidth = ganttColumnsWidth(columnWidths, detailsCollapsed, hiddenColumnKeys);
  const [dividerViewportX, setDividerViewportX] = useState(8);
  const manuallySizedColumns = useRef(new Set<GanttColumnKey>());
  const [collapsedTaskIds, setCollapsedTaskIds] = useState<Set<string>>(() => new Set());
  const ganttSurfaceRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const [virtualRange, setVirtualRange] = useState({ start: 0, end: 40 });
  const range = getGanttDateRange(tasks);
  const rows = useMemo(() => buildGanttRows(tasks), [tasks]);
  const dependencyLinks = useMemo(() => buildGanttDependencyLinks(tasks), [tasks]);
  const rowByTaskId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const childIdsByParentId = useMemo(() => {
    const map = new Map<string, string[]>();
    rows.forEach((row) => {
      if (!row.parentId) return;
      const ids = map.get(row.parentId) ?? [];
      ids.push(row.id);
      map.set(row.parentId, ids);
    });
    return map;
  }, [rows]);
  const taskDepthById = useMemo(() => ganttTaskDepths(rows), [rows]);
  const visibleRows = useMemo(() => rows.filter((row) => {
    let parentId = row.parentId ?? null;
    while (parentId) {
      if (collapsedTaskIds.has(parentId)) return false;
      parentId = rowByTaskId.get(parentId)?.parentId ?? null;
    }
    return true;
  }), [collapsedTaskIds, rowByTaskId, rows]);
  const virtualRows = useMemo(() => visibleRows
    .slice(virtualRange.start, virtualRange.end)
    .map((row, offset) => ({ row, index: virtualRange.start + offset })), [virtualRange, visibleRows]);
  const parentDepths = useMemo(() => [...new Set(rows
    .filter((row) => (childIdsByParentId.get(row.id)?.length ?? 0) > 0)
    .map((row) => taskDepthById.get(row.id) ?? 0))].sort((left, right) => left - right), [childIdsByParentId, rows, taskDepthById]);
  const selectedCount = selectedTaskIds.length;
  const selectedRootTaskIds = useMemo(() => {
    const selected = new Set(selectedTaskIds);
    return rows.filter((row) => {
      if (!selected.has(row.id)) return false;
      let parentId = row.parentId ?? null;
      while (parentId) {
        if (selected.has(parentId)) return false;
        parentId = rowByTaskId.get(parentId)?.parentId ?? null;
      }
      return true;
    }).map((row) => row.id);
  }, [rowByTaskId, rows, selectedTaskIds]);
  const selectedRootSet = useMemo(() => new Set(selectedRootTaskIds), [selectedRootTaskIds]);
  const canOutdentSelection = selectedRootTaskIds.some((taskId) => Boolean(rowByTaskId.get(taskId)?.parentId));
  const canIndentSelection = selectedRootTaskIds.some((taskId) => {
    const task = rowByTaskId.get(taskId);
    if (!task) return false;
    const siblings = rows.filter((row) => (row.parentId ?? null) === (task.parentId ?? null));
    const index = siblings.findIndex((row) => row.id === taskId);
    return index > 0 && !selectedRootSet.has(siblings[index - 1].id);
  });
  const contextTask = contextMenu ? rowByTaskId.get(contextMenu.taskId) : null;
  const contextTaskSiblings = contextTask ? rows.filter((row) => (row.parentId ?? null) === (contextTask.parentId ?? null)) : [];
  const contextTaskSiblingIndex = contextTask ? contextTaskSiblings.findIndex((row) => row.id === contextTask.id) : -1;
  const canOutdentContextTask = Boolean(contextTask?.parentId);
  const canIndentContextTask = contextTaskSiblingIndex > 0;

  useEffect(() => {
    const fitted = fitGanttColumnWidths(rows);
    setColumnWidths((current) => Object.fromEntries(GANTT_EXPANDED_COLUMN_KEYS.map((key) => [
      key,
      manuallySizedColumns.current.has(key) ? current[key] : fitted[key],
    ])) as GanttColumnWidths);
  }, [rows]);

  useEffect(() => {
    setCollapsedTaskIds((current) => {
      const validIds = new Set(rows.filter((row) => childIdsByParentId.has(row.id)).map((row) => row.id));
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [childIdsByParentId, rows]);

  const updateVirtualRange = useCallback(() => {
    const viewport = scrollViewportRef.current;
    const surface = ganttSurfaceRef.current;
    if (!viewport || !surface) return;
    const overscan = 10;
    const bodyScrollTop = Math.max(0, viewport.scrollTop - HEADER_HEIGHT);
    const start = Math.max(0, Math.floor(bodyScrollTop / ROW_HEIGHT) - overscan);
    const visibleCount = Math.ceil(viewport.clientHeight / ROW_HEIGHT) + overscan * 2;
    const end = Math.min(visibleRows.length, start + visibleCount);
    setVirtualRange((current) => current.start === start && current.end === end ? current : { start, end });
    const viewportRect = viewport.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    const boundaryX = viewportRect.left - surfaceRect.left + leftWidth - viewport.scrollLeft;
    const nextDividerX = Math.min(Math.max(boundaryX, 8), Math.max(8, surface.clientWidth - 8));
    setDividerViewportX((current) => Math.abs(current - nextDividerX) < 0.5 ? current : nextDividerX);
  }, [leftWidth, visibleRows.length]);

  useEffect(() => {
    updateVirtualRange();
    const viewport = scrollViewportRef.current;
    const surface = ganttSurfaceRef.current;
    if (!viewport || !surface || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateVirtualRange);
    observer.observe(viewport);
    observer.observe(surface);
    window.addEventListener("resize", updateVirtualRange);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateVirtualRange);
    };
  }, [updateVirtualRange]);

  const resizeColumn = useCallback((key: GanttColumnKey, width: number) => {
    manuallySizedColumns.current.add(key);
    setColumnWidths((current) => ({
      ...current,
      [key]: Math.max(GANTT_COLUMN_MIN_WIDTHS[key], Math.round(width)),
    }));
  }, []);

  const autoFitColumn = useCallback((key: GanttColumnKey) => {
    manuallySizedColumns.current.add(key);
    setColumnWidths((current) => ({ ...current, [key]: fitGanttColumnWidth(key, rows, taskDepthById) }));
  }, [rows, taskDepthById]);

  const toggleColumnVisibility = useCallback((key: GanttColumnKey) => {
    setDetailsCollapsed(false);
    setHiddenColumnKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const showAllColumns = useCallback(() => {
    setDetailsCollapsed(false);
    setHiddenColumnKeys(new Set());
  }, []);

  const toggleTaskCollapsed = useCallback((taskId: string) => {
    setCollapsedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const toggleDepthCollapsed = useCallback((depth: number) => {
    const taskIds = rows
      .filter((row) => (taskDepthById.get(row.id) ?? 0) === depth && childIdsByParentId.has(row.id))
      .map((row) => row.id);
    setCollapsedTaskIds((current) => {
      const next = new Set(current);
      const shouldCollapse = taskIds.some((id) => !next.has(id));
      taskIds.forEach((id) => shouldCollapse ? next.add(id) : next.delete(id));
      return next;
    });
  }, [childIdsByParentId, rows, taskDepthById]);

  const getDescendantIds = (taskId: string) => {
    const result: string[] = [];
    const stack = [...(childIdsByParentId.get(taskId) ?? [])];
    while (stack.length > 0) {
      const childId = stack.shift()!;
      result.push(childId);
      stack.push(...(childIdsByParentId.get(childId) ?? []));
    }
    return result;
  };

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!contextMenu) return;
    const closeOnPointer = () => closeContextMenu();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };
    window.addEventListener("click", closeOnPointer);
    window.addEventListener("scroll", closeOnPointer, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeOnPointer);
      window.removeEventListener("scroll", closeOnPointer, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeContextMenu, contextMenu]);

  const openTaskContextMenu = (event: ReactMouseEvent, taskId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 220;
    const menuHeight = 220;
    setContextMenu({
      taskId,
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - menuWidth - 8)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - menuHeight - 8)),
    });
  };

  const createContextChild = () => {
    if (!contextTask) return;
    setDetailsCollapsed(false);
    setCollapsedTaskIds((current) => {
      if (!current.has(contextTask.id)) return current;
      const next = new Set(current);
      next.delete(contextTask.id);
      return next;
    });
    closeContextMenu();
    onCreateTask?.(contextTask);
  };

  const toggleContextSelection = () => {
    if (!contextTask) return;
    setSelectionMode(true);
    toggleTaskSelection(contextTask.id);
    closeContextMenu();
  };

  const changeContextHierarchy = (direction: GanttHierarchyDirection) => {
    if (!contextTask || hierarchyChanging) return;
    closeContextMenu();
    void onChangeHierarchy?.([contextTask.id], direction);
  };

  const deleteContextTask = () => {
    if (!contextTask || deletingSelected) return;
    closeContextMenu();
    void Promise.resolve(onDeleteSelected?.([contextTask.id]));
  };

  const isSelectedByAncestor = (taskId: string, selectedIds = selectedTaskIds) => {
    const selectedSet = new Set(selectedIds);
    let parentId = rowByTaskId.get(taskId)?.parentId ?? null;
    while (parentId) {
      if (selectedSet.has(parentId)) return true;
      parentId = rowByTaskId.get(parentId)?.parentId ?? null;
    }
    return false;
  };

  const toggleSelectionMode = () => {
    setSelectionMode((prev) => !prev);
    setSelectedTaskIds([]);
  };

  const toggleTaskSelection = (taskId: string) => {
    if (!rowByTaskId.has(taskId)) return;
    setSelectedTaskIds((prev) => {
      if (isSelectedByAncestor(taskId, prev)) return prev;
      const next = new Set(prev);
      const linkedIds = [taskId, ...getDescendantIds(taskId)];
      if (next.has(taskId)) {
        linkedIds.forEach((id) => next.delete(id));
      } else {
        linkedIds.forEach((id) => next.add(id));
      }
      return rows.map((row) => row.id).filter((id) => next.has(id));
    });
  };

  const deleteSelectedTasks = () => {
    if (selectedTaskIds.length === 0) return;
    void Promise.resolve(onDeleteSelected?.(selectedTaskIds)).then(() => {
      setSelectedTaskIds([]);
      setSelectionMode(false);
    });
  };

  const changeSelectedHierarchy = (direction: GanttHierarchyDirection) => {
    if (selectedRootTaskIds.length === 0 || hierarchyChanging) return;
    void onChangeHierarchy?.(selectedTaskIds, direction);
  };

  useEffect(() => {
    if (!flashingTaskId) return;
    const timer = window.setTimeout(() => setFlashingTaskId(null), 900);
    return () => window.clearTimeout(timer);
  }, [flashingTaskId]);

  const getDropPosition = (event: DragEvent<HTMLElement>): DropPosition => {
    const rect = event.currentTarget.getBoundingClientRect();
    const relativeY = event.clientY - rect.top;
    if (relativeY <= rect.height * 0.42) return "before";
    if (relativeY >= rect.height * 0.58) return "after";
    return taskDropTarget?.position ?? "after";
  };

  const reorderTask = (targetTaskId: string, position: DropPosition) => {
    if (!draggedTaskId || draggedTaskId === targetTaskId) return;
    const draggedRow = rows.find((row) => row.id === draggedTaskId);
    const targetRow = rows.find((row) => row.id === targetTaskId);
    if (!draggedRow || !targetRow) return;
    if ((draggedRow.parentId ?? null) !== (targetRow.parentId ?? null)) return;
    const taskIds = rows.map((row) => row.id);
    const fromIndex = taskIds.indexOf(draggedTaskId);
    const toIndex = taskIds.indexOf(targetTaskId);
    if (fromIndex < 0 || toIndex < 0) return;
    const nextTaskIds = [...taskIds];
    const [movedTaskId] = nextTaskIds.splice(fromIndex, 1);
    const targetIndexAfterRemoval = nextTaskIds.indexOf(targetTaskId);
    nextTaskIds.splice(position === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval, 0, movedTaskId);
    setFlashingTaskId(movedTaskId);
    void onReorderTasks?.(nextTaskIds);
  };

  const reorderTaskToEdge = (position: DropPosition) => {
    if (!draggedTaskId) return;
    const draggedRow = rows.find((row) => row.id === draggedTaskId);
    if (!draggedRow) return;
    const siblings = rows.filter((row) => (row.parentId ?? null) === (draggedRow.parentId ?? null));
    const targetRow = position === "before" ? siblings[0] : siblings.at(-1);
    if (!targetRow || targetRow.id === draggedTaskId) return;
    reorderTask(targetRow.id, position);
  };

  if (!range || rows.length === 0) {
    return (
      <EmptyGanttTimeline
        emptyText={emptyText}
        dayWidth={dayWidth}
        zoomIndex={zoomIndex}
        detailsCollapsed={detailsCollapsed}
        hiddenColumnKeys={hiddenColumnKeys}
        setZoomIndex={setZoomIndex}
        setDetailsCollapsed={setDetailsCollapsed}
        columnWidths={columnWidths}
        onAutoFitColumn={autoFitColumn}
        onResizeColumn={resizeColumn}
        onShowAllColumns={showAllColumns}
        onToggleColumn={toggleColumnVisibility}
        fullScreen={fullScreen}
        portalContainer={portalContainer}
        canCreate={canCreate}
        creatingParentId={creatingParentId}
        onCreateTask={onCreateTask}
      />
    );
  }

  const config = { dayWidth, tickEvery: getTickEvery(dayWidth) };
  const visibleStartDate = addCalendarDays(range.startDate, -1);
  const visibleEndDate = addCalendarDays(range.endDate, 7);
  const visibleDays = diffDays(visibleStartDate, visibleEndDate) + 1;
  const timelineWidth = Math.max(MIN_TIMELINE_WIDTH, visibleDays * config.dayWidth);
  const bodyHeight = visibleRows.length * ROW_HEIGHT;
  const todayOffset = diffDays(visibleStartDate, new Date().toISOString().slice(0, 10));
  const todayX = todayOffset >= 0 && todayOffset < visibleDays ? todayOffset * config.dayWidth : null;
  const rowById = new Map(
    visibleRows.map((row, index) => [row.id, { row, index }])
  );
  const categoryCount = new Set(rows.map((row) => row.taskCategory)).size;
  const criticalCount = rows.filter((row) => row.isCritical).length;

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card", fullScreen && "h-full rounded-none")}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/20 px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">项目计划</span>
          <span>{range.startDate} 至 {range.endDate}</span>
          <span>总工期 {range.totalDays} 天</span>
          <span>{rows.length} 个任务</span>
          <span>{categoryCount} 个类别</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="flex items-center gap-1 text-muted-foreground">
            <span className="inline-block h-2.5 w-5 rounded-full bg-primary" />
            任务
          </div>
          <div className="flex items-center gap-1 text-muted-foreground">
            <span className="relative inline-block h-2.5 w-5 overflow-hidden rounded-full bg-primary/25">
              <span className="absolute inset-y-0 left-0 w-1/2 bg-primary" />
            </span>
            进度
          </div>
          <div className="flex items-center gap-1 text-muted-foreground">
            <span className="inline-block h-2.5 w-5 rounded-full bg-destructive" />
            关键路径 {criticalCount}
          </div>
          {reordering && <span className="text-muted-foreground">排序保存中...</span>}

          <div className="flex items-center gap-1 rounded-md border border-border bg-card">
            <button
              type="button"
              onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
              disabled={zoomIndex === 0}
              className="flex !h-6 !min-h-6 !w-6 items-center justify-center !border-0 !bg-transparent !p-0 text-muted-foreground !shadow-none transition hover:!bg-transparent hover:text-primary disabled:opacity-30"
              aria-label="缩小"
              title="缩小"
            >
              <ZoomOut className="h-3 w-3" />
            </button>
            <span className="w-10 text-center text-xs text-muted-foreground">{ZOOM_LABELS[zoomIndex]}</span>
            <button
              type="button"
              onClick={() => setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}
              disabled={zoomIndex === ZOOM_LEVELS.length - 1}
              className="flex !h-6 !min-h-6 !w-6 items-center justify-center !border-0 !bg-transparent !p-0 text-muted-foreground !shadow-none transition hover:!bg-transparent hover:text-primary disabled:opacity-30"
              aria-label="放大"
              title="放大"
            >
              <ZoomIn className="h-3 w-3" />
            </button>
          </div>
          <ColumnVisibilityMenu
            hiddenColumnKeys={hiddenColumnKeys}
            onShowAll={showAllColumns}
            onToggle={toggleColumnVisibility}
            portalContainer={portalContainer}
          />
          {parentDepths.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs">
                  <ListTree className="size-3.5" />
                  折叠层级
                  <ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent container={portalContainer} align="end" className="w-44">
                <DropdownMenuItem onSelect={() => setCollapsedTaskIds(new Set())}>
                  全部展开
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {parentDepths.map((depth) => {
                  const ids = rows
                    .filter((row) => (taskDepthById.get(row.id) ?? 0) === depth && childIdsByParentId.has(row.id))
                    .map((row) => row.id);
                  return (
                    <DropdownMenuCheckboxItem
                      key={depth}
                      checked={ids.length > 0 && ids.every((id) => collapsedTaskIds.has(id))}
                      onCheckedChange={() => toggleDepthCollapsed(depth)}
                      onSelect={(event) => event.preventDefault()}
                    >
                      第 {depth + 1} 层父任务
                    </DropdownMenuCheckboxItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {canCreate && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => {
                setDetailsCollapsed(false);
                onCreateTask?.();
              }}
              disabled={creatingParentId === "root"}
            >
              新增任务
            </Button>
          )}
          {(canEdit || canDelete) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={toggleSelectionMode}
              disabled={deletingSelected || hierarchyChanging}
            >
              {selectionMode ? "取消选择" : "选择"}
            </Button>
          )}
          {canEdit && selectionMode && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => changeSelectedHierarchy("OUTDENT")}
                disabled={!canOutdentSelection || hierarchyChanging}
                title="将所选任务及其全部子任务上移一个层级"
              >
                <IndentDecrease className="size-3.5" />
                上移层级
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => changeSelectedHierarchy("INDENT")}
                disabled={!canIndentSelection || hierarchyChanging}
                title="将所选任务及其全部子任务下移到上一条同级任务下"
              >
                <IndentIncrease className="size-3.5" />
                层级下移
              </Button>
            </>
          )}
          {canDelete && selectionMode && (
            <Button
              size="sm"
              variant="destructive"
              className="h-7 text-xs"
              onClick={deleteSelectedTasks}
              disabled={selectedCount === 0 || deletingSelected}
            >
              {deletingSelected ? "删除中..." : `删除 ${selectedCount}`}
            </Button>
          )}
        </div>
      </div>

      <div ref={ganttSurfaceRef} className={cn("relative min-h-0", fullScreen && "flex-1")}>
        <div
          ref={scrollViewportRef}
          className={cn(
            "min-h-[260px] overflow-auto",
            fullScreen ? "h-full min-h-0" : "max-h-[calc(100vh-240px)]",
          )}
          onScroll={updateVirtualRange}
        >
        <div className="grid min-w-max" style={{ gridTemplateColumns: `${leftWidth}px ${timelineWidth}px` }}>
          <TaskGridHeader
            columnWidths={columnWidths}
            onAutoFitColumn={autoFitColumn}
            onResizeColumn={resizeColumn}
            visibleColumnKeys={visibleColumnKeys}
          />
          <TimelineHeader
            config={config}
            visibleDays={visibleDays}
            visibleStartDate={visibleStartDate}
            width={timelineWidth}
          />

          <div
            className="sticky left-0 z-10 border-r border-border bg-card transition-colors duration-200 hover:border-primary/40"
            style={{ height: bodyHeight }}
          >
            <div
              className={cn(
                "absolute inset-x-0 top-0 z-20 h-3",
                draggedTaskId && "bg-primary/5"
              )}
              onDragOver={(event) => {
                if (!draggedTaskId) return;
                event.preventDefault();
                setTaskDropTarget({ id: "__edge_start__", position: "before" });
              }}
              onDrop={(event) => {
                event.preventDefault();
                reorderTaskToEdge("before");
              }}
            >
              {taskDropTarget?.id === "__edge_start__" && (
                <span className="pointer-events-none absolute inset-x-0 top-0 z-20 h-3 rounded-sm border border-primary/40 bg-sky-400/20 shadow-[0_0_0_1px_rgba(96,165,250,0.22)]" />
              )}
            </div>
            {virtualRows.map(({ row, index }) => (
                <EditableTaskRow
                  key={row.id}
                  canCreate={canCreate}
                  canEdit={canEdit}
                  creatingChild={creatingParentId === row.id}
                  dragged={draggedTaskId === row.id}
                  dropPosition={taskDropTarget?.id === row.id && draggedTaskId !== row.id ? taskDropTarget.position : null}
                  flashing={flashingTaskId === row.id}
                  index={index}
                  visualTop={index * ROW_HEIGHT}
                  isSaving={savingTaskId === row.id}
                  onDragEnd={() => {
                    setDraggedTaskId(null);
                    setTaskDropTarget(null);
                  }}
                  onDragOver={(event) => {
                    if (!draggedTaskId || draggedTaskId === row.id) return;
                    event.preventDefault();
                    setTaskDropTarget({ id: row.id, position: getDropPosition(event) });
                  }}
                  onDragStart={() => setDraggedTaskId(row.id)}
                  onDrop={() => reorderTask(row.id, taskDropTarget?.id === row.id ? taskDropTarget.position : "before")}
                  onOpenContextMenu={(event) => openTaskContextMenu(event, row.id)}
                  onStartChild={() => {
                    setDetailsCollapsed(false);
                    setCollapsedTaskIds((current) => {
                      if (!current.has(row.id)) return current;
                      const next = new Set(current);
                      next.delete(row.id);
                      return next;
                    });
                    onCreateTask?.(row);
                  }}
                  hasChildren={childIdsByParentId.has(row.id)}
                  hierarchyCollapsed={collapsedTaskIds.has(row.id)}
                  onToggleHierarchy={() => toggleTaskCollapsed(row.id)}
                  onToggleSelected={() => toggleTaskSelection(row.id)}
                  onUpdateTask={onUpdateTask}
                  projectMembers={projectMembers}
                  calendarMode={calendarMode}
                  predecessorOptions={tasks}
                  row={row}
                  taskDepth={taskDepthById.get(row.id) ?? 0}
                  selected={selectedTaskIds.includes(row.id)}
                  selectionLocked={isSelectedByAncestor(row.id)}
                  selectionMode={selectionMode}
                  columnWidths={columnWidths}
                  portalContainer={portalContainer}
                  visibleColumnKeys={visibleColumnKeys}
                />
            ))}
            <div
              className={cn(
                "absolute inset-x-0 bottom-0 z-20 h-3",
                draggedTaskId && "bg-primary/5"
              )}
              onDragOver={(event) => {
                if (!draggedTaskId) return;
                event.preventDefault();
                setTaskDropTarget({ id: "__edge_end__", position: "after" });
              }}
              onDrop={(event) => {
                event.preventDefault();
                reorderTaskToEdge("after");
              }}
            >
              {taskDropTarget?.id === "__edge_end__" && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-3 rounded-sm border border-primary/40 bg-sky-400/20 shadow-[0_0_0_1px_rgba(96,165,250,0.22)]" />
              )}
            </div>
          </div>

          <div className="relative" style={{ width: timelineWidth, height: bodyHeight }}>
            <svg
              aria-hidden="true"
              className="absolute inset-0"
              height={bodyHeight}
              width={timelineWidth}
            >
              <TimelineGrid
                config={config}
                height={bodyHeight}
                visibleDays={visibleDays}
                visibleStartDate={visibleStartDate}
              />
              {todayX !== null && (
                <line
                  x1={todayX}
                  x2={todayX}
                  y1={0}
                  y2={bodyHeight}
                  stroke="hsl(var(--destructive))"
                  strokeDasharray="4 4"
                  strokeWidth={1.4}
                />
              )}
              {dependencyLinks.map((link) => {
                const from = rowById.get(link.predecessorId);
                const to = rowById.get(link.successorId);
                if (!from || !to || from.row.spanDays <= 0 || to.row.spanDays <= 0) return null;
                const firstIndex = Math.min(from.index, to.index);
                const lastIndex = Math.max(from.index, to.index);
                if (lastIndex < virtualRange.start || firstIndex >= virtualRange.end) return null;
                const fromX = (diffDays(visibleStartDate, from.row.endDate) + 1) * config.dayWidth;
                const toX = diffDays(visibleStartDate, to.row.startDate) * config.dayWidth;
                const fromY = from.index * ROW_HEIGHT + ROW_HEIGHT / 2;
                const toY = to.index * ROW_HEIGHT + ROW_HEIGHT / 2;
                return (
                  <DependencyConnector
                    key={`${link.predecessorId}-${link.successorId}`}
                    fromX={fromX}
                    fromY={fromY}
                    toX={toX}
                    toY={toY}
                  />
                );
              })}
            </svg>

            {virtualRows.map(({ row, index: visualIndex }) => {
              if (row.spanDays <= 0) return null;
              const left = diffDays(visibleStartDate, row.startDate) * config.dayWidth;
              const width = config.dayWidth * row.spanDays;
              const showBarLabel = width >= 72;
              const barLabel = row.taskName || row.taskCode;
              const progress = Math.min(100, Math.max(0, row.progress ?? 0));
              return (
                <div
                  key={row.id}
                  className="absolute flex items-center"
                  style={{
                    left,
                    top: visualIndex * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2,
                    width,
                    height: BAR_HEIGHT,
                  }}
                >
                  <div
                    className={cn(
                      "relative h-full w-full overflow-hidden rounded-sm border shadow-sm",
                      row.isCritical
                        ? "border-destructive/60 bg-destructive/25"
                        : "border-primary/60 bg-primary/25"
                    )}
                    title={`${barLabel}: ${row.startDate} ~ ${row.endDate}，当前进度 ${progress}%`}
                  >
                    <div
                      className={cn(
                        "h-full rounded-sm",
                        row.isCritical ? "bg-destructive" : "bg-primary"
                      )}
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  {showBarLabel && (
                    <span className="pointer-events-none ml-2 max-w-[180px] truncate text-[11px] text-muted-foreground">
                      {barLabel}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        </div>
        {contextMenu && contextTask && (
          <div
            role="menu"
            aria-label="甘特任务右键菜单"
            className="fixed z-[130] w-[220px] overflow-hidden rounded-md border border-border bg-card p-1 text-card-foreground shadow-[var(--app-shadow-popover)]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              <div className="truncate font-medium text-foreground">{contextTask.taskCode || "未编号"} · {contextTask.taskName || "未命名任务"}</div>
              <div className="mt-0.5 truncate">{getDescendantIds(contextTask.id).length > 0 ? "含 " + getDescendantIds(contextTask.id).length + " 个子任务" : "无子任务"}</div>
            </div>
            {canCreate && (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                disabled={creatingParentId === contextTask.id}
                onClick={createContextChild}
              >
                <Plus className="size-4" />
                新增子任务
              </button>
            )}
            {(canEdit || canDelete) && (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                onClick={toggleContextSelection}
              >
                <ListChecks className="size-4" />
                {selectedTaskIds.includes(contextTask.id) ? "取消选择" : "选择任务"}
              </button>
            )}
            {canEdit && (
              <>
                <div className="-mx-1 my-1 h-px bg-border" />
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                  disabled={!canOutdentContextTask || hierarchyChanging}
                  onClick={() => changeContextHierarchy("OUTDENT")}
                >
                  <IndentDecrease className="size-4" />
                  上移层级
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                  disabled={!canIndentContextTask || hierarchyChanging}
                  onClick={() => changeContextHierarchy("INDENT")}
                >
                  <IndentIncrease className="size-4" />
                  层级下移
                </button>
              </>
            )}
            {canDelete && (
              <>
                <div className="-mx-1 my-1 h-px bg-border" />
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-destructive outline-none transition-colors hover:bg-destructive/10 focus:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
                  disabled={deletingSelected}
                  onClick={deleteContextTask}
                >
                  <Trash2 className="size-4" />
                  删除任务（含子任务）
                </button>
              </>
            )}
          </div>
        )}
        <GanttDividerToggle
          collapsed={detailsCollapsed}
          onToggle={() => setDetailsCollapsed((prev) => !prev)}
          className="top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{ left: dividerViewportX }}
        />
      </div>
    </div>
  );
};

export const GanttTimeline = (props: GanttTimelineProps) => (
  <TooltipProvider>
    <GanttTimelineContent {...props} />
  </TooltipProvider>
);

const EmptyGanttTimeline = ({
  canCreate,
  creatingParentId,
  dayWidth,
  zoomIndex,
  detailsCollapsed,
  hiddenColumnKeys,
  columnWidths,
  emptyText,
  onAutoFitColumn,
  onCreateTask,
  onResizeColumn,
  onShowAllColumns,
  onToggleColumn,
  setZoomIndex,
  setDetailsCollapsed,
  fullScreen,
  portalContainer,
}: {
  canCreate: boolean;
  creatingParentId: string | null;
  dayWidth: number;
  zoomIndex: number;
  detailsCollapsed: boolean;
  hiddenColumnKeys: ReadonlySet<GanttColumnKey>;
  columnWidths: GanttColumnWidths;
  emptyText: string;
  onAutoFitColumn: (key: GanttColumnKey) => void;
  onCreateTask?: (parentTask?: ProjectGanttTask) => void;
  onResizeColumn: (key: GanttColumnKey, width: number) => void;
  onShowAllColumns: () => void;
  onToggleColumn: (key: GanttColumnKey) => void;
  setZoomIndex: (value: number | ((prev: number) => number)) => void;
  setDetailsCollapsed: (value: boolean | ((prev: boolean) => boolean)) => void;
  fullScreen: boolean;
  portalContainer?: HTMLElement | null;
}) => {
  const config = { dayWidth, tickEvery: getTickEvery(dayWidth) };
  const visibleStartDate = new Date().toISOString().slice(0, 10);
  const visibleDays = 28;
  const timelineWidth = Math.max(MIN_TIMELINE_WIDTH, visibleDays * config.dayWidth);
  const visibleColumnKeys = ganttVisibleColumnKeys(detailsCollapsed, hiddenColumnKeys);
  const leftWidth = ganttColumnsWidth(columnWidths, detailsCollapsed, hiddenColumnKeys);
  const bodyHeight = ROW_HEIGHT * 3;

  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-card", fullScreen && "flex h-full min-h-0 flex-col rounded-none")}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/20 px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">项目计划</span>
          <span>暂无排期数据</span>
          <span>0 个任务</span>
          <span>0 个类别</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="flex items-center gap-1 text-muted-foreground">
            <span className="inline-block h-2.5 w-5 rounded-full bg-primary" />
            任务
          </div>
          <div className="flex items-center gap-1 text-muted-foreground">
            <span className="relative inline-block h-2.5 w-5 overflow-hidden rounded-full bg-primary/25">
              <span className="absolute inset-y-0 left-0 w-1/2 bg-primary" />
            </span>
            进度
          </div>
          <div className="flex items-center gap-1 text-muted-foreground">
            <span className="inline-block h-2.5 w-5 rounded-full bg-destructive" />
            关键路径 0
          </div>

          <div className="flex items-center gap-1 rounded-md border border-border bg-card">
            <button
              type="button"
              onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
              disabled={zoomIndex === 0}
              className="flex !h-6 !min-h-6 !w-6 items-center justify-center !border-0 !bg-transparent !p-0 text-muted-foreground !shadow-none transition hover:!bg-transparent hover:text-primary disabled:opacity-30"
              aria-label="缩小"
              title="缩小"
            >
              <ZoomOut className="h-3 w-3" />
            </button>
            <span className="w-10 text-center text-xs text-muted-foreground">{ZOOM_LABELS[zoomIndex]}</span>
            <button
              type="button"
              onClick={() => setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}
              disabled={zoomIndex === ZOOM_LEVELS.length - 1}
              className="flex !h-6 !min-h-6 !w-6 items-center justify-center !border-0 !bg-transparent !p-0 text-muted-foreground !shadow-none transition hover:!bg-transparent hover:text-primary disabled:opacity-30"
              aria-label="放大"
              title="放大"
            >
              <ZoomIn className="h-3 w-3" />
            </button>
          </div>
          <ColumnVisibilityMenu
            hiddenColumnKeys={hiddenColumnKeys}
            onShowAll={onShowAllColumns}
            onToggle={onToggleColumn}
            portalContainer={portalContainer}
          />
          {canCreate && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => {
                setDetailsCollapsed(false);
                onCreateTask?.();
              }}
              disabled={creatingParentId === "root"}
            >
              新增任务
            </Button>
          )}
        </div>
      </div>

      <div className={cn("overflow-auto", fullScreen && "min-h-0 flex-1")}>
        <div className="grid min-w-max" style={{ gridTemplateColumns: `${leftWidth}px ${timelineWidth}px` }}>
          <TaskGridHeader
            columnWidths={columnWidths}
            onAutoFitColumn={onAutoFitColumn}
            onResizeColumn={onResizeColumn}
            visibleColumnKeys={visibleColumnKeys}
          />
          <TimelineHeader
            config={config}
            visibleDays={visibleDays}
            visibleStartDate={visibleStartDate}
            width={timelineWidth}
          />

          <div className="sticky left-0 z-10 flex items-center justify-center border-r border-border bg-background text-xs text-muted-foreground transition-colors duration-200 hover:border-primary/40" style={{ height: bodyHeight }}>
            <GanttDividerToggle
              collapsed={detailsCollapsed}
              onToggle={() => setDetailsCollapsed((prev) => !prev)}
              className="-right-2 top-1/2 -translate-y-1/2"
            />
            {emptyText}
          </div>
          <div className="relative" style={{ width: timelineWidth, height: bodyHeight }}>
            <svg aria-hidden="true" className="absolute inset-0" height={bodyHeight} width={timelineWidth}>
              <TimelineGrid
                config={config}
                height={bodyHeight}
                visibleDays={visibleDays}
                visibleStartDate={visibleStartDate}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
              请新增任务后生成排期
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const ColumnResizeHandle = ({
  columnKey,
  onAutoFit,
  onResize,
  width,
}: {
  columnKey: GanttColumnKey;
  onAutoFit: (key: GanttColumnKey) => void;
  onResize: (key: GanttColumnKey, width: number) => void;
  width: number;
}) => {
  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = width;
    const handleMove = (moveEvent: PointerEvent) => onResize(columnKey, startWidth + moveEvent.clientX - startX);
    const handleEnd = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd, { once: true });
  };

  return (
    <button
      type="button"
      className="absolute -right-1 top-0 z-30 flex !h-full !min-h-0 !w-2 cursor-col-resize items-center justify-center !rounded-none !border-0 !bg-transparent !p-0 !shadow-none outline-none hover:!bg-transparent focus-visible:!shadow-none"
      onPointerDown={startResize}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onAutoFit(columnKey);
      }}
      title="拖拽调整列宽，双击自动适应内容"
      aria-label={`调整${GANTT_COLUMN_LABELS[columnKey] || "拖拽"}列宽`}
    >
      <span className="h-full w-px bg-primary/70 opacity-0 transition-opacity group-hover/column:opacity-100 focus-visible:opacity-100" />
    </button>
  );
};

const TaskGridHeader = ({
  columnWidths,
  onAutoFitColumn,
  onResizeColumn,
  visibleColumnKeys,
}: {
  columnWidths: GanttColumnWidths;
  onAutoFitColumn: (key: GanttColumnKey) => void;
  onResizeColumn: (key: GanttColumnKey, width: number) => void;
  visibleColumnKeys: GanttColumnKey[];
}) => {
  return (
    <div
      className="sticky top-0 left-0 z-20 box-border grid items-center border-b border-r border-border bg-muted text-[11px] font-medium text-foreground"
      style={{
        height: HEADER_HEIGHT,
        gridTemplateColumns: visibleColumnKeys.map((key) => `${columnWidths[key]}px`).join(" "),
      }}
    >
      {visibleColumnKeys.map((key) => (
        <div key={key} className="group/column relative flex h-full min-w-0 items-center px-2">
          <span className="whitespace-nowrap">{GANTT_COLUMN_LABELS[key]}</span>
          {key !== "drag" && (
            <ColumnResizeHandle
              columnKey={key}
              onAutoFit={onAutoFitColumn}
              onResize={onResizeColumn}
              width={columnWidths[key]}
            />
          )}
        </div>
      ))}
    </div>
  );
};

const DurationDaysInput = ({
  disabled,
  onCommit,
  value,
}: {
  disabled: boolean;
  onCommit: (value: number) => void;
  value: number;
}) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => value > 0 ? String(value) : "");

  useEffect(() => {
    if (!editing) setText(value > 0 ? String(value) : "");
  }, [editing, value]);

  const commit = () => {
    const next = text.trim() ? normalizeGanttDurationDays(Number(text)) : 0;
    setEditing(false);
    setText(next > 0 ? String(next) : "");
    onCommit(next);
  };

  return (
    <Input
      type="text"
      inputMode="decimal"
      value={editing ? text : value > 0 ? String(value) : "--"}
      onFocus={() => {
        setEditing(true);
        setText(value > 0 ? String(value) : "");
      }}
      onChange={(event) => {
        const next = event.target.value.replace(/[^\d.]/g, "");
        if (/^\d*(?:\.\d*)?$/.test(next)) setText(next);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setEditing(false);
          setText(value > 0 ? String(value) : "");
          event.currentTarget.blur();
        }
      }}
      className={durationFieldClass}
      disabled={disabled}
      aria-label="工期天数"
      title="单位：天；支持 0.5 天步进，留空表示未排期"
    />
  );
};

const ActualWorkHoursInput = ({
  disabled,
  onCommit,
  value,
}: {
  disabled: boolean;
  onCommit: (value: number) => void;
  value: number;
}) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => value > 0 ? roundGanttHours(value).toFixed(2) : "");

  useEffect(() => {
    if (!editing) setText(value > 0 ? roundGanttHours(value).toFixed(2) : "");
  }, [editing, value]);

  const commit = () => {
    const next = roundGanttHours(Number(text || 0));
    setEditing(false);
    setText(next > 0 ? next.toFixed(2) : "");
    onCommit(next);
  };

  return (
    <Input
      type="text"
      inputMode="decimal"
      value={editing ? text : value > 0 ? roundGanttHours(value).toFixed(2) : "--"}
      onFocus={() => {
        setEditing(true);
        setText(value > 0 ? roundGanttHours(value).toFixed(2) : "");
      }}
      onChange={(event) => {
        const next = event.target.value.replace(/[^\d.]/g, "");
        if (/^\d*(?:\.\d{0,2})?$/.test(next)) setText(next);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setEditing(false);
          setText(value > 0 ? roundGanttHours(value).toFixed(2) : "");
          event.currentTarget.blur();
        }
      }}
      className={durationFieldClass}
      disabled={disabled}
      aria-label="实际工时"
      title="单位：小时，最多两位小数"
    />
  );
};

const EditableTaskRow = ({
  calendarMode,
  canCreate,
  canEdit,
  creatingChild,
  dragged,
  dropPosition,
  flashing,
  hasChildren,
  hierarchyCollapsed,
  index,
  isSaving,
  onDragEnd,
  onDragOver,
  onDragStart,
  onDrop,
  onOpenContextMenu,
  onStartChild,
  onToggleHierarchy,
  onToggleSelected,
  onUpdateTask,
  predecessorOptions,
  projectMembers,
  row,
  taskDepth,
  visualTop,
  selected,
  selectionLocked,
  selectionMode,
  columnWidths,
  portalContainer,
  visibleColumnKeys,
}: {
  calendarMode: GanttCalendarMode;
  canCreate: boolean;
  canEdit: boolean;
  creatingChild: boolean;
  dragged: boolean;
  dropPosition: DropPosition | null;
  flashing: boolean;
  hasChildren: boolean;
  hierarchyCollapsed: boolean;
  index: number;
  isSaving: boolean;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragStart: () => void;
  onDrop: () => void;
  onOpenContextMenu: (event: ReactMouseEvent) => void;
  onStartChild?: () => void;
  onToggleHierarchy: () => void;
  onToggleSelected: () => void;
  onUpdateTask?: (task: ProjectGanttTask, draft: GanttTaskDraft) => void | Promise<void>;
  predecessorOptions: ProjectGanttTask[];
  projectMembers: ProjectMember[];
  row: ReturnType<typeof buildGanttRows>[number];
  taskDepth: number;
  visualTop: number;
  selected: boolean;
  selectionLocked: boolean;
  selectionMode: boolean;
  columnWidths: GanttColumnWidths;
  portalContainer?: HTMLElement | null;
  visibleColumnKeys: GanttColumnKey[];
}) => {
  const [draft, setDraft] = useState<GanttTaskDraft>(() => toTaskDraft(row, calendarMode));
  const isColumnVisible = (key: GanttColumnKey) => visibleColumnKeys.includes(key);
  const isChildTask = taskDepth > 0;
  const levelColor = GANTT_DEPTH_COLORS[taskDepth % GANTT_DEPTH_COLORS.length];
  const levelCycle = Math.floor(taskDepth / GANTT_DEPTH_COLORS.length);
  const levelLightness = Math.max(42, levelColor.lightness - levelCycle * 6);
  const levelRowStyle = {
    "--gantt-level-row": `hsl(${levelColor.hue} ${levelColor.saturation}% ${levelLightness}% / 0.024)`,
    "--gantt-level-hover": `hsl(${levelColor.hue} ${levelColor.saturation}% ${levelLightness}% / 0.08)`,
    "--gantt-level-accent": `hsl(${levelColor.hue} ${levelColor.saturation}% ${levelLightness}% / 0.68)`,
  } as CSSProperties & Record<"--gantt-level-row" | "--gantt-level-hover" | "--gantt-level-accent", string>;

  const updateDraft = <K extends keyof GanttTaskDraft>(key: K, value: GanttTaskDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const updateTaskName = (value: string) => {
    updateDraft("taskName", value.replace(/【关键路径】/g, "").replace(/【关键路径/g, "").replace(/关键路径】/g, ""));
  };

  const commitDraft = () => {
    if (!canEdit || taskDraftEquals(row, draft, calendarMode)) return;
    void onUpdateTask?.(row, draft);
  };

  const withPlannedStart = (current: GanttTaskDraft, value: string): GanttTaskDraft => ({
    ...current,
    startDate: value,
    endDate: value ? calculateTaskFinishDate(value, current.durationDays, calendarMode) : current.endDate,
  });

  const withPlannedEnd = (current: GanttTaskDraft, value: string): GanttTaskDraft => ({
    ...current,
    endDate: value,
    durationDays: current.startDate && value
      ? calculateTaskDurationDays(current.startDate, value, calendarMode)
      : current.durationDays,
    estimatedWorkHours: current.startDate && value
      ? estimatedHoursForDuration(calculateTaskDurationDays(current.startDate, value, calendarMode))
      : current.estimatedWorkHours,
  });

  const withActualStart = (current: GanttTaskDraft, value: string): GanttTaskDraft => ({
    ...current,
    actualStartDate: value,
  });

  const withActualEnd = (current: GanttTaskDraft, value: string): GanttTaskDraft => ({
    ...current,
    actualEndDate: value,
  });

  const updateDateDraft = (
    builder: (current: GanttTaskDraft, value: string) => GanttTaskDraft,
    value: string,
  ) => {
    setDraft((current) => builder(current, value));
  };

  const commitDateDraft = (
    builder: (current: GanttTaskDraft, value: string) => GanttTaskDraft,
    value: string,
  ) => {
    const nextDraft = builder(draft, value);
    setDraft(nextDraft);
    if (canEdit && !taskDraftEquals(row, nextDraft, calendarMode)) {
      void onUpdateTask?.(row, nextDraft);
    }
  };

  useEffect(() => {
    setDraft(toTaskDraft(row, calendarMode));
  }, [calendarMode, row]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
    if (event.key === "Escape") {
      setDraft(toTaskDraft(row, calendarMode));
      event.currentTarget.blur();
    }
  };

  return (
    <div
      className={cn(
        "group relative box-border grid cursor-default items-center border-b border-border text-xs transition-[background,box-shadow,transform] duration-150",
        "bg-[var(--gantt-level-row)] hover:bg-[var(--gantt-level-hover)]",
        row.isCritical
          ? "shadow-[inset_3px_0_0_hsl(var(--destructive))]"
          : "shadow-[inset_2px_0_0_var(--gantt-level-accent)]",
        selected && "!bg-primary/15 hover:!bg-primary/20",
        dragged && "scale-[0.995] opacity-45 shadow-lg",
        dropPosition && "!bg-primary/10"
      )}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onContextMenu={onOpenContextMenu}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      style={{
        position: "absolute",
        insetInline: 0,
        top: visualTop,
        height: ROW_HEIGHT,
        gridTemplateColumns: visibleColumnKeys.map((key) => `${columnWidths[key]}px`).join(" "),
        contentVisibility: dropPosition || dragged ? "visible" : "auto",
        containIntrinsicSize: `${ROW_HEIGHT}px`,
        ...levelRowStyle,
      }}
    >
      {flashing && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 bg-sky-400/30 animate-[gantt-row-drop-flash_0.5s_ease-out_forwards]"
        />
      )}
      {dropPosition && !dragged && (
        <span
          className={cn(
            "pointer-events-none absolute left-0 right-0 z-20 h-5 rounded-sm border border-primary/45 bg-sky-400/25 shadow-[0_0_0_1px_rgba(96,165,250,0.26)]",
            dropPosition === "before" ? "-top-2.5" : "-bottom-2.5"
          )}
        />
      )}
      <span
        role="button"
        tabIndex={canEdit ? 0 : -1}
        draggable={canEdit}
        onDragStart={(event) => {
          if (!canEdit) return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", row.id);
          onDragStart();
        }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.preventDefault();
        }}
        className={cn(
          "flex h-full w-full items-center justify-center border-0 bg-transparent p-0 text-muted-foreground/65 opacity-75 outline-none transition-colors hover:text-foreground focus-visible:text-foreground",
          canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-default opacity-30",
          dragged && "text-primary opacity-100"
        )}
        title={canEdit ? "拖拽排序" : "当前不可排序"}
        aria-label={canEdit ? "拖拽排序" : "当前不可排序"}
        aria-disabled={!canEdit}
      >
        <GripVertical className="h-3.5 w-3.5 transition-transform group-hover:scale-105" strokeWidth={1.7} />
        <span className="sr-only">拖拽排序</span>
      </span>
      <div className="relative flex min-w-0 items-center gap-1 px-2" style={{ paddingLeft: `${8 + taskDepth * 10}px` }}>
        {selectionMode && (
          <input
            type="checkbox"
            checked={selected}
            disabled={selectionLocked}
            onChange={onToggleSelected}
            className="h-3.5 w-3.5 rounded border-border bg-background disabled:cursor-not-allowed disabled:opacity-60"
            onClick={(event) => event.stopPropagation()}
            title={selectionLocked ? "父任务已选中，子任务随父任务联动选择" : undefined}
          />
        )}
        {hasChildren ? (
          <button
            type="button"
            className="flex !size-4 !min-h-0 shrink-0 items-center justify-center rounded-sm !border-0 !bg-transparent !p-0 text-muted-foreground !shadow-none transition-colors hover:!bg-primary/10 hover:text-primary focus-visible:!shadow-none"
            onClick={(event) => {
              event.stopPropagation();
              onToggleHierarchy();
            }}
            title={hierarchyCollapsed ? "展开子任务" : "折叠子任务"}
            aria-label={hierarchyCollapsed ? "展开子任务" : "折叠子任务"}
          >
            {hierarchyCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
        ) : <span className="size-4 shrink-0" aria-hidden="true" />}
        {isChildTask && <span className="h-px w-2 shrink-0 bg-[var(--gantt-level-accent)]" />}
        <span
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap pr-12 font-mono text-[11px] font-semibold text-[var(--gantt-level-accent)]"
          title={row.taskCode || row.id}
        >
          {row.taskCode || `Task${index + 1}`}
        </span>
        {canCreate && (
          <button
            type="button"
            className="absolute right-0 top-1/2 inline-flex h-5 -translate-y-1/2 items-center gap-0.5 rounded border border-border/70 bg-card/95 px-1.5 text-[10px] text-muted-foreground opacity-0 shadow-sm transition hover:border-primary/50 hover:text-primary focus-visible:opacity-100 group-hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onStartChild?.();
            }}
            disabled={creatingChild}
            title={creatingChild ? "创建中..." : "新增子任务"}
            aria-label={creatingChild ? "创建中..." : "新增子任务"}
            style={{
              height: 20,
              minHeight: 20,
              padding: "0 6px",
              fontSize: 10,
              lineHeight: 1,
              transform: "translateY(-50%)",
            }}
          >
            <CornerDownRight className="h-3 w-3" />
            <span>子任务</span>
          </button>
        )}
      </div>
      {isColumnVisible("taskCategory") && (
        <Input
          value={draft.taskCategory}
          onBlur={commitDraft}
          onChange={(event) => updateDraft("taskCategory", event.target.value)}
          onKeyDown={handleKeyDown}
          className={inlineFieldClass}
          disabled={!canEdit || isSaving}
          placeholder="任务类别"
        />
      )}
      <div className="relative min-w-0">
        <Input
          value={draft.taskName}
          onBlur={commitDraft}
          onChange={(event) => updateTaskName(event.target.value)}
          onKeyDown={handleKeyDown}
          className={cn(inlineFieldClass, "font-medium", row.isCritical && "pr-[76px] text-destructive")}
          disabled={!canEdit || isSaving}
          style={{ paddingLeft: `${8 + taskDepth * 18}px` }}
          placeholder="任务名称"
          title={row.isCritical ? `${draft.taskName}【关键路径】` : draft.taskName}
        />
        {row.isCritical && (
          <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] font-medium text-destructive">
            【关键路径】
          </span>
        )}
      </div>
      {isColumnVisible("taskDescription") && (draft.taskDescription.trim() ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="min-w-0">
              <Input
                value={draft.taskDescription}
                onBlur={commitDraft}
                onChange={(event) => updateDraft("taskDescription", event.target.value)}
                onKeyDown={handleKeyDown}
                className={inlineFieldClass}
                disabled={!canEdit || isSaving}
                placeholder="任务描述"
                aria-label="任务描述"
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" align="start" className="max-w-[min(480px,calc(100vw-2rem))] whitespace-pre-wrap break-words leading-5">
            {draft.taskDescription}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Input
          value={draft.taskDescription}
          onBlur={commitDraft}
          onChange={(event) => updateDraft("taskDescription", event.target.value)}
          onKeyDown={handleKeyDown}
          className={inlineFieldClass}
          disabled={!canEdit || isSaving}
          placeholder="任务描述"
          aria-label="任务描述"
        />
      ))}
      {isColumnVisible("owner") && (
          <Select
            value={draft.ownerMemberId ?? ""}
            aria-label="负责人"
            onChange={(event) => {
              const nextDraft = { ...draft, ownerMemberId: event.target.value || null };
              setDraft(nextDraft);
              if (canEdit && !taskDraftEquals(row, nextDraft, calendarMode)) {
                void onUpdateTask?.(row, nextDraft);
              }
            }}
            className={inlineSelectClass}
            portalContainer={portalContainer}
            variant="ghost"
            disabled={!canEdit || isSaving}
          >
            <option value="">未分配</option>
            {projectMembers.map((member) => (
              <option key={member.id} value={member.id}>
                {member.personName}（{member.roleName}）
              </option>
            ))}
          </Select>
      )}
      {isColumnVisible("durationDays") && (
          <DurationDaysInput
            value={draft.durationDays}
            disabled={!canEdit || isSaving}
            onCommit={(durationDays) => {
              const nextDraft = {
                ...draft,
                durationDays,
                endDate: draft.startDate ? calculateTaskFinishDate(draft.startDate, durationDays, calendarMode) : "",
                estimatedWorkHours: estimatedHoursForDuration(durationDays),
              };
              setDraft(nextDraft);
              if (canEdit && !taskDraftEquals(row, nextDraft, calendarMode)) {
                void onUpdateTask?.(row, nextDraft);
              }
            }}
          />
      )}
      {isColumnVisible("startDate") && (
          <GanttDateField
            value={draft.startDate}
            onChange={(value) => updateDateDraft(withPlannedStart, value)}
            onCommit={(value) => commitDateDraft(withPlannedStart, value)}
            disabled={!canEdit || isSaving}
            ariaLabel="计划开始"
            required
          />
      )}
      {isColumnVisible("endDate") && (
          <GanttDateField
            value={draft.endDate}
            onChange={(value) => updateDateDraft(withPlannedEnd, value)}
            onCommit={(value) => commitDateDraft(withPlannedEnd, value)}
            disabled={!canEdit || isSaving}
            ariaLabel="计划完成"
            min={draft.startDate}
            required={draft.durationDays > 0}
          />
      )}
      {isColumnVisible("actualStartDate") && (
          <GanttDateField
            value={draft.actualStartDate}
            onChange={(value) => updateDateDraft(withActualStart, value)}
            onCommit={(value) => commitDateDraft(withActualStart, value)}
            disabled={!canEdit || isSaving}
            ariaLabel="实际开始"
          />
      )}
      {isColumnVisible("actualEndDate") && (
          <GanttDateField
            value={draft.actualEndDate}
            onChange={(value) => updateDateDraft(withActualEnd, value)}
            onCommit={(value) => commitDateDraft(withActualEnd, value)}
            disabled={!canEdit || isSaving}
            ariaLabel="实际完成"
            min={draft.actualStartDate || undefined}
          />
      )}
      {isColumnVisible("estimatedWorkHours") && (
          <Input
            type="text"
            value={draft.estimatedWorkHours > 0 ? roundGanttHours(draft.estimatedWorkHours).toFixed(2) : "--"}
            className={durationFieldClass}
            readOnly
            aria-label="预计工时"
            title="按工期 × 7.5 小时自动计算"
          />
      )}
      {isColumnVisible("actualWorkHours") && (
          <ActualWorkHoursInput
            value={draft.actualWorkHours}
            disabled={!canEdit || isSaving}
            onCommit={(value) => {
              const nextDraft = { ...draft, actualWorkHours: value };
              setDraft(nextDraft);
              if (canEdit && !taskDraftEquals(row, nextDraft, calendarMode)) {
                void onUpdateTask?.(row, nextDraft);
              }
            }}
          />
      )}
      {isColumnVisible("progress") && (
          <div className="flex min-w-0 items-center gap-1">
            <Input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={draft.progress}
              onBlur={commitDraft}
              onChange={(event) => {
                const digits = event.target.value.replace(/\D/g, "");
                updateDraft("progress", digits ? Math.min(100, Number(digits)) : 0);
              }}
              onKeyDown={handleKeyDown}
              className={durationFieldClass}
              disabled={!canEdit || isSaving}
              aria-label="当前进度"
            />
            <span className="text-[10px] text-muted-foreground">%</span>
          </div>
      )}
      {isColumnVisible("predecessor") && (
          <PredecessorSelect
            value={draft.predecessorTaskIds}
            onChange={(predecessorTaskIds) => {
              const nextDraft = { ...draft, predecessorTaskIds };
              setDraft(nextDraft);
              if (canEdit && !taskDraftEquals(row, nextDraft, calendarMode)) {
                void onUpdateTask?.(row, nextDraft);
              }
            }}
            options={predecessorOptions}
            currentTaskId={row.id}
            disabled={!canEdit || isSaving}
            portalContainer={portalContainer}
          />
      )}
      {isColumnVisible("remark") && (
        <Input
          value={draft.remark}
          onBlur={commitDraft}
          onChange={(event) => updateDraft("remark", event.target.value)}
          onKeyDown={handleKeyDown}
          className={inlineFieldClass}
          disabled={!canEdit || isSaving}
          placeholder="备注"
          title={draft.remark}
        />
      )}
    </div>
  );
};

const PredecessorSelect = ({
  currentTaskId,
  disabled,
  onChange,
  options,
  portalContainer,
  value,
}: {
  currentTaskId: string;
  disabled?: boolean;
  onChange: (value: string[]) => void;
  options: ProjectGanttTask[];
  portalContainer?: HTMLElement | null;
  value: string[];
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingValue, setPendingValue] = useState<string[]>(value);
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => new Set());
  const taskById = useMemo(() => new Map(options.map((task) => [task.id, task])), [options]);
  const childIdsByParentId = useMemo(() => {
    const result = new Map<string, string[]>();
    options.forEach((task) => {
      if (!task.parentId) return;
      const childIds = result.get(task.parentId) ?? [];
      childIds.push(task.id);
      result.set(task.parentId, childIds);
    });
    return result;
  }, [options]);
  const unavailableTaskIds = useMemo(() => {
    const result = new Set([currentTaskId]);
    const queue = [...(childIdsByParentId.get(currentTaskId) ?? [])];
    while (queue.length > 0) {
      const taskId = queue.shift();
      if (!taskId || result.has(taskId)) continue;
      result.add(taskId);
      queue.push(...(childIdsByParentId.get(taskId) ?? []));
    }
    return result;
  }, [childIdsByParentId, currentTaskId]);
  const availableOptions = useMemo(
    () => options.filter((task) => task.taskName.trim() && !unavailableTaskIds.has(task.id)),
    [options, unavailableTaskIds],
  );
  const availableTaskIds = useMemo(() => new Set(availableOptions.map((task) => task.id)), [availableOptions]);
  const matchingOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return availableOptions;
    return availableOptions.filter((task) => [task.taskCode, task.taskName, task.taskCategory]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery));
  }, [availableOptions, query]);
  const visibleOptions = useMemo(() => {
    if (query.trim()) return matchingOptions;
    return matchingOptions.filter((task) => {
      let parentId = task.parentId ?? null;
      while (parentId) {
        if (availableTaskIds.has(parentId) && !expandedTaskIds.has(parentId)) return false;
        parentId = taskById.get(parentId)?.parentId ?? null;
      }
      return true;
    });
  }, [availableTaskIds, expandedTaskIds, matchingOptions, query, taskById]);

  useEffect(() => {
    if (!open) setPendingValue(value);
  }, [open, value]);

  const getTaskDepth = (task: ProjectGanttTask) => {
    let depth = 0;
    let parentId = task.parentId ?? null;
    while (parentId) {
      if (availableTaskIds.has(parentId)) depth += 1;
      parentId = taskById.get(parentId)?.parentId ?? null;
    }
    return depth;
  };

  const expandSelectedAncestors = (selectedTaskIds: string[]) => {
    const next = new Set<string>();
    selectedTaskIds.forEach((taskId) => {
      let parentId = taskById.get(taskId)?.parentId ?? null;
      while (parentId) {
        if (availableTaskIds.has(parentId)) next.add(parentId);
        parentId = taskById.get(parentId)?.parentId ?? null;
      }
    });
    setExpandedTaskIds(next);
  };

  const changeOpen = (nextOpen: boolean) => {
    if (nextOpen) {
      const nextValue = value.filter((taskId) => availableTaskIds.has(taskId));
      setPendingValue(nextValue);
      setQuery("");
      expandSelectedAncestors(nextValue);
    } else {
      setQuery("");
      setPendingValue(value);
    }
    setOpen(nextOpen);
  };

  const togglePendingValue = (taskId: string) => {
    setPendingValue((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return availableOptions.map((task) => task.id).filter((id) => next.has(id));
    });
  };

  const selectedTasks = value
    .map((taskId) => taskById.get(taskId))
    .filter((task): task is ProjectGanttTask => Boolean(task));
  const triggerText = selectedTasks.length === 0
    ? "无"
    : selectedTasks.length === 1
      ? `${selectedTasks[0].taskCode || selectedTasks[0].taskName}`
      : `已选 ${selectedTasks.length} 项`;
  const valuesChanged = pendingValue.length !== value.length
    || pendingValue.some((taskId, index) => taskId !== value[index]);

  return (
    <DropdownMenu open={open} onOpenChange={changeOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="紧前任务"
          className={cn(inlineSelectClass, "flex items-center gap-1 text-left disabled:pointer-events-none")}
          disabled={disabled}
          title={selectedTasks.map((task) => `${task.taskCode} · ${task.taskName}`).join("\n") || "无"}
        >
          <span className="min-w-0 flex-1 truncate">{triggerText}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent container={portalContainer} align="end" className="w-[360px] max-w-[calc(100vw-24px)] p-0" onCloseAutoFocus={(event) => event.preventDefault()}>
        <div className="border-b border-border p-2" onKeyDown={(event) => event.stopPropagation()}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="搜索紧前任务"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-7 pl-7 text-xs"
              placeholder="搜索任务 ID、名称或类别"
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {visibleOptions.length === 0 ? (
            <p className="px-2 py-5 text-center text-xs text-muted-foreground">没有可选择的紧前任务</p>
          ) : visibleOptions.map((task) => {
            const childIds = (childIdsByParentId.get(task.id) ?? []).filter((id) => availableTaskIds.has(id));
            const hasChildren = childIds.length > 0;
            const isExpanded = expandedTaskIds.has(task.id);
            const selected = pendingValue.includes(task.id);
            const depth = getTaskDepth(task);
            return (
              <div
                key={task.id}
                className="flex min-h-8 items-center gap-1 rounded-sm pr-2 text-xs hover:bg-accent"
                style={{ paddingLeft: `${6 + depth * 16}px` }}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    aria-label={`${isExpanded ? "折叠" : "展开"} ${task.taskCode || task.taskName} 子任务`}
                    className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => setExpandedTaskIds((current) => {
                      const next = new Set(current);
                      if (next.has(task.id)) next.delete(task.id);
                      else next.add(task.id);
                      return next;
                    })}
                  >
                    {isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  </button>
                ) : <span className="size-5 shrink-0" aria-hidden="true" />}
                <input
                  type="checkbox"
                  aria-label={`选择 ${task.taskCode || task.taskName}`}
                  checked={selected}
                  onChange={() => togglePendingValue(task.id)}
                  className="size-3.5 shrink-0 rounded border-border bg-background"
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate py-1 text-left text-foreground"
                  onClick={() => togglePendingValue(task.id)}
                  title={`${task.taskCode} · ${task.taskName}`}
                >
                  <span className="font-mono text-[11px]">{task.taskCode || "未编号"} · {task.taskName}</span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-2 py-2">
          <span className="text-xs text-muted-foreground">已选择 {pendingValue.length} 项</span>
          <div className="flex items-center gap-1.5">
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => changeOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              aria-label="应用紧前任务"
              disabled={!valuesChanged}
              onClick={() => {
                onChange(pendingValue);
                changeOpen(false);
              }}
            >
              应用
            </Button>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const TimelineHeader = ({
  config,
  visibleDays,
  visibleStartDate,
  width,
}: {
  config: { dayWidth: number; tickEvery: number };
  visibleDays: number;
  visibleStartDate: string;
  width: number;
}) => {
  const ticks = Array.from({ length: visibleDays }, (_, index) => ({
    date: addCalendarDays(visibleStartDate, index),
    x: index * config.dayWidth,
  })).filter((_, index) => index % config.tickEvery === 0);

  const formatDate = (dateStr: string): string => {
    const d = parseGanttDate(dateStr);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    if (config.dayWidth >= 60) return `${m}-${String(day).padStart(2, "0")}`;
    if (config.dayWidth >= 20) return `${m}/${day}`;
    if (config.dayWidth >= 8) return `${m}月`;
    return `${y}年${m}月`;
  };

  return (
    <div className="sticky top-0 z-10 border-b border-border bg-muted" style={{ width, height: HEADER_HEIGHT }}>
      <svg height={HEADER_HEIGHT} width={width} aria-hidden="true">
        {ticks.map((tick) => {
          const date = parseGanttDate(tick.date);
          const isWeekend = [0, 6].includes(date.getUTCDay());
          const label = formatDate(tick.date);
          return (
            <g key={tick.date}>
              <line x1={tick.x} x2={tick.x} y1={0} y2={HEADER_HEIGHT} className="stroke-border" />
              <text
                x={tick.x + 4}
                y={HEADER_HEIGHT / 2 + 4}
                className={isWeekend ? "fill-muted-foreground" : "fill-foreground"}
                fontSize={11}
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};

const TimelineGrid = ({
  config,
  height,
  visibleDays,
  visibleStartDate,
}: {
  config: { dayWidth: number; tickEvery: number };
  height: number;
  visibleDays: number;
  visibleStartDate: string;
}) => (
  <>
    {Array.from({ length: visibleDays }, (_, index) => {
      const date = parseGanttDate(addCalendarDays(visibleStartDate, index));
      const isWeekend = [0, 6].includes(date.getUTCDay());
      const x = index * config.dayWidth;
      return (
        <g key={index}>
          {isWeekend && (
            <rect x={x} y={0} width={config.dayWidth} height={height} className="fill-muted opacity-20" />
          )}
          {index % config.tickEvery === 0 && (
            <line x1={x} x2={x} y1={0} y2={height} className="stroke-border" strokeWidth={1} />
          )}
        </g>
      );
    })}
    {Array.from({ length: Math.ceil(height / ROW_HEIGHT) + 1 }, (_, index) => (
      <line
        key={index}
        x1={0}
        x2="100%"
        y1={index * ROW_HEIGHT}
        y2={index * ROW_HEIGHT}
        className="stroke-border"
        strokeWidth={1}
      />
    ))}
  </>
);

const DependencyConnector = ({
  fromX,
  fromY,
  toX,
  toY,
}: {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}) => {
  const elbow = Math.max(fromX + 12, Math.min(toX - 12, fromX + 28));
  const endX = Math.max(toX - 4, 0);
  const path = `M ${fromX} ${fromY} L ${elbow} ${fromY} L ${elbow} ${toY} L ${endX} ${toY}`;

  return (
    <g>
      <path d={path} fill="none" stroke="#94a3b8" strokeDasharray="4 3" strokeWidth={1.4} />
      <polygon points={`${endX},${toY - 4} ${endX},${toY + 4} ${toX + 3},${toY}`} fill="#94a3b8" />
    </g>
  );
};
