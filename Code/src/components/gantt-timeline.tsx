"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronRight as MenuChevronRight, ClipboardPaste, Columns3, Copy, Filter, GripVertical, IndentDecrease, IndentIncrease, ListTree, Plus, Scissors, Star, Trash2, TriangleAlert, UserRoundCog, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { GanttDateField } from "@/components/gantt-date-field";
import { HierarchicalMultiSelect, type HierarchicalSelectOption } from "@/components/hierarchical-multi-select";
import { Input } from "@/components/ui/input";
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
  GANTT_DEFAULT_HIDDEN_COLUMN_KEYS,
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
import { ganttFloatDays, GANTT_MINUTES_PER_DAY, type GanttScheduleStatus } from "@/lib/gantt-cpm";
import { buildGanttUnassignedLeafTasksByParentId } from "@/lib/gantt-owner-hierarchy";
import {
  filterGanttRowsWithAncestors,
  ganttFilterOptions,
  type GanttFilterKey,
  type GanttFilterState,
} from "@/lib/gantt-filters";
import {
  calculateTaskDurationDays,
  calculateTaskFinishDate,
  estimatedHoursForDuration,
  normalizeGanttDurationDays,
  roundGanttHours,
  shiftTaskDate,
  type GanttCalendarMode,
} from "@/lib/gantt-calendar";
import { cn } from "@/lib/utils";

interface GanttTimelineProps {
  projectId?: string;
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
  resourceConflictMessagesByTaskId?: Record<string, string[]>;
  onCreateTask?: (parentTask?: ProjectGanttTask) => void;
  historyFocusRequest?: GanttHistoryFocusRequest | null;
  onUpdateTask?: (task: ProjectGanttTask, draft: GanttTaskDraft, columnKey?: string) => void | Promise<void>;
  onDeleteSelected?: (taskIds: string[]) => void | Promise<void>;
  onChangeHierarchy?: (taskIds: string[], direction: GanttHierarchyDirection) => void | Promise<void>;
  onReassignBranch?: (taskId: string, ownerMemberId: string | null) => void | Promise<void>;
  onInsertTasks?: (
    anchorTaskId: string,
    placement: GanttInsertPlacement,
    count: number,
  ) => Promise<{ createdTaskIds?: string[] } | void>;
  onPasteTasks?: (
    mode: GanttClipboardMode,
    sourceTaskIds: string[],
    anchorTaskId: string,
    position: GanttPastePosition,
  ) => Promise<{ taskIds?: string[] } | void>;
  onActionError?: (message: string) => void;
  onReorderTasks?: (taskIds: string[], movedTaskId?: string) => void | Promise<void>;
}

interface GanttHistoryFocusRequest {
  requestId: number;
  taskIds: string[];
  columnKey?: string;
  anchorTaskId?: string;
}

type GanttInsertPlacement = "SIBLING_BEFORE" | "SIBLING_AFTER" | "CHILD_FIRST" | "CHILD_LAST";
type GanttPastePosition = "BEFORE" | "AFTER";
type GanttClipboardMode = "COPY" | "MOVE";

interface GanttClipboardState {
  projectId: string;
  mode: GanttClipboardMode;
  taskIds: string[];
}

export type GanttTaskDraft = {
  parentId?: string | null;
  ownerMemberId?: string | null;
  ownerMemberIds?: string[];
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
  isMilestone: boolean;
  predecessorTaskIds: string[];
  remark: string;
};

const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 32;
const BAR_HEIGHT = 10;
const MIN_TIMELINE_WIDTH = 860;
const ZOOM_LEVELS = [1, 3, 8, 20, 60];
const GANTT_FILTER_KEYS: GanttFilterKey[] = [
  "taskName",
  "taskDescription",
  "owner",
  "durationDays",
  "startDate",
  "endDate",
  "predecessor",
];
const ZOOM_LABELS = ["60天", "30天", "15天", "5天", "1天"];
const DEFAULT_ZOOM_INDEX = 2;
const SCHEDULE_STATUS_LABELS: Record<GanttScheduleStatus, string> = {
  UNSCHEDULED: "未排程",
  INVALID_DEPENDENCY: "依赖异常",
  NEGATIVE_FLOAT: "负浮动",
  CRITICAL: "关键",
  NEAR_CRITICAL: "近关键",
  NORMAL: "正常",
};
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

const escapeCssSelector = (value: string) => (
  typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&")
);

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

const GanttColumnFilterMenu = ({
  columnKey,
  options,
  selectedValues,
  onChange,
  portalContainer,
}: {
  columnKey: GanttFilterKey;
  options: string[];
  selectedValues?: string[];
  onChange: (values?: string[]) => void;
  portalContainer?: HTMLElement | null;
}) => {
  const [search, setSearch] = useState("");
  const active = Array.isArray(selectedValues);
  const checkedValues = active ? selectedValues : options;
  const normalizedSearch = search.trim().toLocaleLowerCase("zh-CN");
  const visibleOptions = options.filter((option) => option.toLocaleLowerCase("zh-CN").includes(normalizedSearch));
  const toggleValue = (value: string) => {
    const nextValues = checkedValues.includes(value)
      ? checkedValues.filter((item) => item !== value)
      : [...checkedValues, value];
    onChange(nextValues.length === options.length ? undefined : nextValues);
  };

  return (
    <DropdownMenu onOpenChange={(open) => !open && setSearch("")}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "ml-auto flex !size-5 !min-h-0 shrink-0 items-center justify-center !rounded-none !border-0 !bg-transparent !p-0 text-muted-foreground !shadow-none outline-none transition-colors hover:!border-0 hover:!bg-transparent hover:text-foreground focus-visible:!border-0 focus-visible:!bg-transparent focus-visible:!shadow-none focus-visible:text-primary active:!transform-none",
            active && "text-primary",
          )}
          aria-label={`筛选${GANTT_COLUMN_LABELS[columnKey]}`}
          title={`筛选${GANTT_COLUMN_LABELS[columnKey]}`}
        >
          <Filter className={cn("size-3", active && "fill-current")} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent container={portalContainer} align="start" className="w-60 p-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          className="mb-2 h-7 text-xs"
          placeholder="搜索筛选项"
          aria-label={`搜索${GANTT_COLUMN_LABELS[columnKey]}筛选项`}
        />
        <div className="mb-1 flex items-center justify-between px-1 text-[11px]">
          <button type="button" className="text-primary hover:underline" onClick={() => onChange(undefined)}>全选</button>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onChange([])}>清空</button>
        </div>
        <div className="max-h-64 overflow-y-auto">
          {visibleOptions.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">无匹配项</div>
          ) : visibleOptions.map((option) => (
            <DropdownMenuCheckboxItem
              key={option}
              checked={checkedValues.includes(option)}
              onCheckedChange={() => toggleValue(option)}
              onSelect={(event) => event.preventDefault()}
              className="text-xs"
            >
              <span className="truncate" title={option}>{option}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const getTickEvery = (dayWidth: number) => {
  if (dayWidth >= 60) return 1;
  if (dayWidth >= 20) return 5;
  if (dayWidth >= 8) return 15;
  if (dayWidth >= 3) return 30;
  return 30;
};

const floatCalendarSpanDays = (
  endDate: string,
  floatMinutes: number | null | undefined,
  mode: GanttCalendarMode,
) => {
  if (!endDate || !floatMinutes || floatMinutes <= 0) return 0;
  const floatDays = floatMinutes / GANTT_MINUTES_PER_DAY;
  const wholeDays = Math.floor(floatDays);
  const remainder = floatDays - wholeDays;
  const shifted = wholeDays > 0 ? shiftTaskDate(endDate, wholeDays, mode) : endDate;
  return Math.max(0, diffDays(endDate, shifted) + remainder);
};

const formatFloat = (minutes: number | null | undefined) => {
  const days = ganttFloatDays(minutes);
  return days == null ? "--" : `${days} 天`;
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
  ownerMemberIds: task.ownerMemberIds?.length
    ? [...task.ownerMemberIds]
    : task.ownerMembers?.length
      ? task.ownerMembers.map((owner) => owner.id)
      : task.ownerMemberId ? [task.ownerMemberId] : [],
  taskCategory: task.taskCategory,
  taskName: task.taskName,
  taskDescription: task.taskDescription?.trim() || "无",
  startDate: task.startDate,
  endDate: task.finishDate || calculateTaskFinishDate(task.startDate, task.durationDays, calendarMode),
  durationDays: task.durationDays,
  actualStartDate: task.actualStartDate ?? "",
  actualEndDate: task.actualEndDate ?? "",
  estimatedWorkHours: estimatedHoursForDuration(task.durationDays),
  actualWorkHours: roundGanttHours(task.actualWorkHours ?? 0),
  progress: Math.min(100, Math.max(0, task.progress ?? 0)),
  isMilestone: Boolean(task.isMilestone),
  predecessorTaskIds: task.predecessorTaskIds ?? [],
  remark: task.remark ?? "",
});

const taskDraftEquals = (task: ProjectGanttTask, draft: GanttTaskDraft, calendarMode: GanttCalendarMode) => (
  task.taskCategory === draft.taskCategory
    && task.taskName === draft.taskName
    && (task.taskDescription?.trim() || "无") === draft.taskDescription
    && task.startDate === draft.startDate
    && (task.finishDate || calculateTaskFinishDate(task.startDate, task.durationDays, calendarMode)) === draft.endDate
    && task.durationDays === draft.durationDays
    && (task.actualStartDate ?? "") === draft.actualStartDate
    && (task.actualEndDate ?? "") === draft.actualEndDate
    && estimatedHoursForDuration(task.durationDays) === draft.estimatedWorkHours
    && roundGanttHours(task.actualWorkHours ?? 0) === draft.actualWorkHours
    && (task.progress ?? 0) === draft.progress
    && Boolean(task.isMilestone) === draft.isMilestone
    && JSON.stringify(task.predecessorTaskIds ?? []) === JSON.stringify(draft.predecessorTaskIds)
    && (task.remark ?? "") === draft.remark
    && (task.parentId ?? null) === (draft.parentId ?? null)
    && JSON.stringify([...(task.ownerMemberIds?.length
      ? task.ownerMemberIds
      : task.ownerMembers?.length
        ? task.ownerMembers.map((owner) => owner.id)
        : task.ownerMemberId ? [task.ownerMemberId] : [])].sort())
      === JSON.stringify([...(draft.ownerMemberIds ?? (draft.ownerMemberId ? [draft.ownerMemberId] : []))].sort())
);

const GanttTimelineContent = ({
  projectId = "",
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
  resourceConflictMessagesByTaskId = {},
  historyFocusRequest,
  onCreateTask,
  onUpdateTask,
  onDeleteSelected,
  onChangeHierarchy,
  onReassignBranch,
  onInsertTasks,
  onPasteTasks,
  onActionError,
  onReorderTasks,
}: GanttTimelineProps) => {
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const [showFloat, setShowFloat] = useState(true);
  const dayWidth = ZOOM_LEVELS[zoomIndex];
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  const [explicitSelectedTaskIds, setExplicitSelectedTaskIds] = useState<string[]>([]);
  const [selectionAnchorTaskId, setSelectionAnchorTaskId] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<GanttClipboardState | null>(null);
  const selectionDragRef = useRef<{ startIndex: number; active: boolean } | null>(null);
  const processedHistoryFocusRequestId = useRef<number | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [taskDropTarget, setTaskDropTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  const [flashingTaskId, setFlashingTaskId] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<GanttColumnWidths>({ ...GANTT_COLUMN_MIN_WIDTHS });
  const [hiddenColumnKeys, setHiddenColumnKeys] = useState<Set<GanttColumnKey>>(
    () => new Set(GANTT_DEFAULT_HIDDEN_COLUMN_KEYS),
  );
  const [columnFilters, setColumnFilters] = useState<GanttFilterState>({});
  const [contextMenu, setContextMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [contextSubmenu, setContextSubmenu] = useState<"paste" | "insert" | "owner" | null>(null);
  const [insertCount, setInsertCount] = useState(1);
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
  const [embeddedViewportHeight, setEmbeddedViewportHeight] = useState<number | null>(null);
  const range = getGanttDateRange(tasks);
  const rows = useMemo(() => buildGanttRows(tasks), [tasks]);
  const filteredRows = useMemo(
    () => filterGanttRowsWithAncestors(rows, columnFilters),
    [columnFilters, rows],
  );
  const filterOptionsByKey = useMemo(() => Object.fromEntries(
    GANTT_FILTER_KEYS.map((key) => [key, ganttFilterOptions(rows, key)]),
  ) as Record<GanttFilterKey, string[]>, [rows]);
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
  const unassignedLeafTasksByParentId = useMemo(
    () => buildGanttUnassignedLeafTasksByParentId(rows),
    [rows],
  );
  const taskDepthById = useMemo(() => ganttTaskDepths(rows), [rows]);
  const visibleRows = useMemo(() => filteredRows.filter((row) => {
    let parentId = row.parentId ?? null;
    while (parentId) {
      if (collapsedTaskIds.has(parentId)) return false;
      parentId = rowByTaskId.get(parentId)?.parentId ?? null;
    }
    return true;
  }), [collapsedTaskIds, filteredRows, rowByTaskId]);
  const virtualRows = useMemo(() => visibleRows
    .slice(virtualRange.start, virtualRange.end)
    .map((row, offset) => ({ row, index: virtualRange.start + offset })), [virtualRange, visibleRows]);
  const parentDepths = useMemo(() => [...new Set(rows
    .filter((row) => (childIdsByParentId.get(row.id)?.length ?? 0) > 0)
    .map((row) => taskDepthById.get(row.id) ?? 0))].sort((left, right) => left - right), [childIdsByParentId, rows, taskDepthById]);
  const linkedSelectedTaskIds = useMemo(() => {
    const linked = new Set<string>();
    const explicit = new Set(explicitSelectedTaskIds);
    explicitSelectedTaskIds.forEach((taskId) => {
      const stack = [...(childIdsByParentId.get(taskId) ?? [])];
      while (stack.length > 0) {
        const childId = stack.shift()!;
        if (!explicit.has(childId)) linked.add(childId);
        stack.push(...(childIdsByParentId.get(childId) ?? []));
      }
    });
    return rows.map((row) => row.id).filter((id) => linked.has(id));
  }, [childIdsByParentId, explicitSelectedTaskIds, rows]);
  const selectedTaskIds = useMemo(() => {
    const selected = new Set([...explicitSelectedTaskIds, ...linkedSelectedTaskIds]);
    return rows.map((row) => row.id).filter((id) => selected.has(id));
  }, [explicitSelectedTaskIds, linkedSelectedTaskIds, rows]);
  const explicitSelectedTaskIdSet = useMemo(() => new Set(explicitSelectedTaskIds), [explicitSelectedTaskIds]);
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
  const contextTaskHasChildren = Boolean(contextTask && (childIdsByParentId.get(contextTask.id)?.length ?? 0) > 0);
  const movedClipboardTaskIds = useMemo(() => {
    if (!clipboard || clipboard.mode !== "MOVE" || clipboard.projectId !== projectId) return new Set<string>();
    const moved = new Set<string>();
    const stack = [...clipboard.taskIds];
    while (stack.length > 0) {
      const taskId = stack.pop()!;
      if (moved.has(taskId)) continue;
      moved.add(taskId);
      stack.push(...(childIdsByParentId.get(taskId) ?? []));
    }
    return moved;
  }, [childIdsByParentId, clipboard, projectId]);
  const invalidMovePasteTarget = Boolean(contextTask && movedClipboardTaskIds.has(contextTask.id));

  useEffect(() => {
    setClipboard(null);
    setExplicitSelectedTaskIds([]);
    setSelectionAnchorTaskId(null);
    setColumnFilters({});
  }, [projectId]);

  useEffect(() => {
    const validIds = new Set(rows.map((row) => row.id));
    setExplicitSelectedTaskIds((current) => current.filter((id) => validIds.has(id)));
    setSelectionAnchorTaskId((current) => current && validIds.has(current) ? current : null);
  }, [rows]);

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
    if (!fullScreen) {
      const nextHeight = Math.max(260, Math.floor(window.innerHeight - viewportRect.top - 1));
      setEmbeddedViewportHeight((current) => current === nextHeight ? current : nextHeight);
    }
    const surfaceRect = surface.getBoundingClientRect();
    const boundaryX = viewportRect.left - surfaceRect.left + leftWidth;
    const nextDividerX = Math.min(Math.max(boundaryX, 8), Math.max(8, surface.clientWidth - 8));
    setDividerViewportX((current) => Math.abs(current - nextDividerX) < 0.5 ? current : nextDividerX);
  }, [fullScreen, leftWidth, visibleRows.length]);

  useEffect(() => {
    updateVirtualRange();
    const viewport = scrollViewportRef.current;
    const surface = ganttSurfaceRef.current;
    if (!viewport || !surface) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateVirtualRange);
    observer?.observe(viewport);
    observer?.observe(surface);
    window.addEventListener("resize", updateVirtualRange);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateVirtualRange);
    };
  }, [updateVirtualRange]);

  useEffect(() => {
    if (!historyFocusRequest) return;
    if (processedHistoryFocusRequestId.current === historyFocusRequest.requestId) return;
    const taskId = historyFocusRequest.taskIds.find((id) => rowByTaskId.has(id))
      ?? (historyFocusRequest.anchorTaskId && rowByTaskId.has(historyFocusRequest.anchorTaskId)
        ? historyFocusRequest.anchorTaskId
        : null);
    if (!taskId) return;
    processedHistoryFocusRequestId.current = historyFocusRequest.requestId;

    const nextCollapsed = new Set(collapsedTaskIds);
    let parentId = rowByTaskId.get(taskId)?.parentId ?? null;
    while (parentId) {
      nextCollapsed.delete(parentId);
      parentId = rowByTaskId.get(parentId)?.parentId ?? null;
    }
    setCollapsedTaskIds((current) => (
      current.size === nextCollapsed.size && [...current].every((id) => nextCollapsed.has(id))
        ? current
        : nextCollapsed
    ));
    if (historyFocusRequest.columnKey) {
      const columnKey = historyFocusRequest.columnKey as GanttColumnKey;
      if (GANTT_EXPANDED_COLUMN_KEYS.includes(columnKey)) {
        setDetailsCollapsed(false);
        setHiddenColumnKeys((current) => {
          if (!current.has(columnKey)) return current;
          const next = new Set(current);
          next.delete(columnKey);
          return next;
        });
      }
    }

    const focusedRows = rows.filter((row) => {
      let currentParentId = row.parentId ?? null;
      while (currentParentId) {
        if (nextCollapsed.has(currentParentId)) return false;
        currentParentId = rowByTaskId.get(currentParentId)?.parentId ?? null;
      }
      return true;
    });
    const targetIndex = focusedRows.findIndex((row) => row.id === taskId);
    if (targetIndex < 0) return;
    setVirtualRange({ start: Math.max(0, targetIndex - 12), end: Math.min(focusedRows.length, targetIndex + 14) });

    window.setTimeout(() => {
      const viewport = scrollViewportRef.current;
      if (!viewport) return;
      const rowNode = document.querySelector<HTMLElement>(`[data-gantt-task-id="${escapeCssSelector(taskId)}"]`);
      const viewportRect = viewport.getBoundingClientRect();
      const rowRect = rowNode?.getBoundingClientRect();
      const fullyVisible = Boolean(rowRect
        && rowRect.top >= viewportRect.top + HEADER_HEIGHT
        && rowRect.bottom <= viewportRect.bottom
        && rowRect.left >= viewportRect.left
        && rowRect.right <= viewportRect.right);
      if (!fullyVisible) {
        viewport.scrollTop = Math.max(0, HEADER_HEIGHT + targetIndex * ROW_HEIGHT - viewport.clientHeight / 2 + ROW_HEIGHT / 2);
        updateVirtualRange();
      }
      window.requestAnimationFrame(() => {
        const refreshedRow = document.querySelector<HTMLElement>(`[data-gantt-task-id="${escapeCssSelector(taskId)}"]`);
        const cell = historyFocusRequest.columnKey
          ? refreshedRow?.querySelector<HTMLElement>(`[data-gantt-column-key="${escapeCssSelector(historyFocusRequest.columnKey)}"]`)
          : null;
        const target = cell ?? refreshedRow;
        if (!target) return;
        if (!fullyVisible) target.scrollIntoView({ block: "center", inline: "center" });
        const className = cell ? "gantt-history-cell-flash" : "gantt-history-row-flash";
        target.classList.remove(className);
        void target.offsetWidth;
        target.classList.add(className);
        window.setTimeout(() => target.classList.remove(className), 500);
      });
    }, 0);
  }, [collapsedTaskIds, historyFocusRequest, rowByTaskId, rows, updateVirtualRange]);

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

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setContextSubmenu(null);
    setInsertCount(1);
  }, []);

  const clearTaskSelection = useCallback(() => {
    selectionDragRef.current = null;
    setExplicitSelectedTaskIds([]);
    setSelectionAnchorTaskId(null);
  }, []);

  useEffect(() => {
    const clearOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      clearTaskSelection();
      closeContextMenu();
    };
    const clearOnBlankPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-gantt-task-id], .gantt-context-menu")) return;
      clearTaskSelection();
    };
    window.addEventListener("keydown", clearOnEscape);
    document.addEventListener("pointerdown", clearOnBlankPointerDown);
    return () => {
      window.removeEventListener("keydown", clearOnEscape);
      document.removeEventListener("pointerdown", clearOnBlankPointerDown);
    };
  }, [clearTaskSelection, closeContextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeOnPointer = () => closeContextMenu();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };
    window.addEventListener("click", closeOnPointer);
    window.addEventListener("pointerdown", closeOnPointer);
    window.addEventListener("contextmenu", closeOnPointer);
    window.addEventListener("scroll", closeOnPointer, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeOnPointer);
      window.removeEventListener("pointerdown", closeOnPointer);
      window.removeEventListener("contextmenu", closeOnPointer);
      window.removeEventListener("scroll", closeOnPointer, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeContextMenu, contextMenu]);

  const openTaskContextMenu = (event: ReactMouseEvent, taskId: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedTaskIds.includes(taskId)) {
      setExplicitSelectedTaskIds([taskId]);
      setSelectionAnchorTaskId(taskId);
    }
    const menuWidth = 286;
    const menuHeight = 430;
    const offset = 6;
    setInsertCount(1);
    setContextSubmenu(null);
    setContextMenu({
      taskId,
      x: Math.max(8, Math.min(event.clientX + offset, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY + offset, window.innerHeight - menuHeight - 8)),
    });
  };

  const changeContextHierarchy = (direction: GanttHierarchyDirection) => {
    if (!contextTask || hierarchyChanging || selectedTaskIds.length === 0) return;
    closeContextMenu();
    void onChangeHierarchy?.(selectedTaskIds, direction);
  };

  const deleteContextTask = () => {
    if (!contextTask || deletingSelected || selectedTaskIds.length === 0) return;
    closeContextMenu();
    void Promise.resolve(onDeleteSelected?.(selectedTaskIds)).then(() => {
      setExplicitSelectedTaskIds([]);
      setSelectionAnchorTaskId(null);
    });
  };

  const reassignContextBranch = async (ownerMemberId: string | null) => {
    if (!contextTask || !onReassignBranch) return;
    closeContextMenu();
    try {
      await onReassignBranch(contextTask.id, ownerMemberId);
    } catch (error) {
      onActionError?.(error instanceof Error ? error.message : "分支批量改派失败");
    }
  };

  const toggleContextMilestone = async () => {
    if (!contextTask || !canEdit || !onUpdateTask) return;
    const nextDraft = { ...toTaskDraft(contextTask, calendarMode), isMilestone: !contextTask.isMilestone };
    closeContextMenu();
    await onUpdateTask(contextTask, nextDraft, "isMilestone");
  };

  const selectTaskRange = useCallback((fromTaskId: string, toTaskId: string) => {
    const fromIndex = rows.findIndex((row) => row.id === fromTaskId);
    const toIndex = rows.findIndex((row) => row.id === toTaskId);
    if (fromIndex < 0 || toIndex < 0) return;
    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);
    setExplicitSelectedTaskIds(rows.slice(start, end + 1).map((row) => row.id));
  }, [rows]);

  const selectTaskFromSequence = useCallback((
    taskId: string,
    index: number,
    event: Pick<ReactPointerEvent, "metaKey" | "ctrlKey" | "shiftKey">,
  ) => {
    if (linkedSelectedTaskIds.includes(taskId) && !explicitSelectedTaskIds.includes(taskId)) return;
    if (event.shiftKey && selectionAnchorTaskId) {
      selectTaskRange(selectionAnchorTaskId, taskId);
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      setExplicitSelectedTaskIds((current) => current.includes(taskId)
        ? current.filter((id) => id !== taskId)
        : rows.map((row) => row.id).filter((id) => id === taskId || current.includes(id)));
      setSelectionAnchorTaskId(taskId);
      return;
    }
    setExplicitSelectedTaskIds([taskId]);
    setSelectionAnchorTaskId(taskId);
    selectionDragRef.current = { startIndex: index, active: true };
  }, [explicitSelectedTaskIds, linkedSelectedTaskIds, rows, selectTaskRange, selectionAnchorTaskId]);

  const extendSequenceSelection = useCallback((index: number, buttons: number) => {
    const drag = selectionDragRef.current;
    if (!drag?.active || buttons !== 1) return;
    const start = Math.min(drag.startIndex, index);
    const end = Math.max(drag.startIndex, index);
    setExplicitSelectedTaskIds(rows.slice(start, end + 1).map((row) => row.id));
  }, [rows]);

  useEffect(() => {
    const finishSelectionDrag = () => {
      if (selectionDragRef.current) selectionDragRef.current.active = false;
    };
    window.addEventListener("pointerup", finishSelectionDrag);
    window.addEventListener("pointercancel", finishSelectionDrag);
    return () => {
      window.removeEventListener("pointerup", finishSelectionDrag);
      window.removeEventListener("pointercancel", finishSelectionDrag);
    };
  }, []);

  const toggleAllTaskSelection = useCallback(() => {
    setExplicitSelectedTaskIds((current) => current.length === rows.length ? [] : rows.map((row) => row.id));
    setSelectionAnchorTaskId(rows[0]?.id ?? null);
  }, [rows]);

  const performInsert = async (placement: GanttInsertPlacement) => {
    if (!contextTask || !onInsertTasks) return;
    const count = Math.max(1, Math.min(100, Math.trunc(insertCount || 1)));
    if (placement.startsWith("CHILD")) {
      setDetailsCollapsed(false);
      setCollapsedTaskIds((current) => {
        const next = new Set(current);
        next.delete(contextTask.id);
        return next;
      });
    }
    closeContextMenu();
    try {
      const result = await onInsertTasks(contextTask.id, placement, count);
      const createdTaskIds = result?.createdTaskIds ?? [];
      if (createdTaskIds.length > 0) {
        setExplicitSelectedTaskIds(createdTaskIds);
        setSelectionAnchorTaskId(createdTaskIds[0]);
      }
    } catch (error) {
      onActionError?.(error instanceof Error ? error.message : "插入任务失败");
    }
  };

  const copyOrCutSelection = useCallback((mode: GanttClipboardMode) => {
    const taskIds = mode === "COPY" ? explicitSelectedTaskIds : selectedRootTaskIds;
    if (!projectId || taskIds.length === 0) return;
    setClipboard({ projectId, mode, taskIds });
    closeContextMenu();
  }, [closeContextMenu, explicitSelectedTaskIds, projectId, selectedRootTaskIds]);

  const pasteSelection = async (position: GanttPastePosition) => {
    if (!contextTask || !clipboard || clipboard.projectId !== projectId || !onPasteTasks) return;
    if (clipboard.mode === "MOVE" && movedClipboardTaskIds.has(contextTask.id)) {
      onActionError?.("剪切任务不能粘贴到自身或其子任务附近，请选择其他目标行");
      closeContextMenu();
      return;
    }
    closeContextMenu();
    try {
      const result = await onPasteTasks(clipboard.mode, clipboard.taskIds, contextTask.id, position);
      const taskIds = result?.taskIds ?? [];
      if (taskIds.length > 0) {
        setExplicitSelectedTaskIds(taskIds);
        setSelectionAnchorTaskId(taskIds[0]);
      }
      if (clipboard.mode === "MOVE") setClipboard(null);
    } catch (error) {
      onActionError?.(error instanceof Error ? error.message : "粘贴任务失败");
    }
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
      if (key === "c" && explicitSelectedTaskIds.length > 0) {
        event.preventDefault();
        copyOrCutSelection("COPY");
      } else if (key === "x" && selectedRootTaskIds.length > 0) {
        event.preventDefault();
        copyOrCutSelection("MOVE");
      } else if (key === "v" && clipboard && selectedTaskIds.length > 0) {
        event.preventDefault();
        const taskId = selectedTaskIds[0];
        const node = document.querySelector<HTMLElement>(`[data-gantt-task-id="${CSS.escape(taskId)}"]`);
        const rect = node?.getBoundingClientRect();
        setInsertCount(1);
        setContextSubmenu("paste");
        setContextMenu({
          taskId,
          x: Math.max(8, Math.min((rect?.left ?? 24) + 36, window.innerWidth - 294)),
          y: Math.max(8, Math.min((rect?.top ?? 24) + 8, window.innerHeight - 438)),
        });
      }
    };
    window.addEventListener("keydown", handleClipboardShortcut);
    return () => window.removeEventListener("keydown", handleClipboardShortcut);
  }, [clipboard, copyOrCutSelection, explicitSelectedTaskIds, selectedRootTaskIds, selectedTaskIds]);

  useEffect(() => {
    if (!flashingTaskId) return;
    const timer = window.setTimeout(() => setFlashingTaskId(null), 500);
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
    void onReorderTasks?.(nextTaskIds, movedTaskId);
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
  const maxFloatCalendarSpan = rows.reduce((maximum, row) => Math.max(
    maximum,
    floatCalendarSpanDays(row.endDate, row.freeFloatMinutes, calendarMode),
  ), 0);
  const visibleEndDate = addCalendarDays(range.endDate, Math.max(7, Math.ceil(maxFloatCalendarSpan) + 2));
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
  const activeFilterCount = Object.values(columnFilters).filter((values) => Array.isArray(values)).length;
  const updateColumnFilter = (key: GanttFilterKey, values?: string[]) => {
    setColumnFilters((current) => {
      const next = { ...current };
      if (values === undefined) delete next[key];
      else next[key] = values;
      return next;
    });
  };

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card", fullScreen && "h-full rounded-none")}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/20 px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">项目计划</span>
          <span>{range.startDate} 至 {range.endDate}</span>
          <span>总工期 {range.totalDays} 天</span>
          <span>{rows.length} 个任务</span>
          <span>{categoryCount} 个类别</span>
          {activeFilterCount > 0 && (
            <button type="button" className="text-primary hover:underline" onClick={() => setColumnFilters({})}>
              已筛选 {visibleRows.length} 行 · 清除筛选
            </button>
          )}
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
            <button
              type="button"
              className={cn(
                "flex h-6 items-center gap-1 rounded border border-border bg-transparent px-2 text-xs text-muted-foreground transition-colors hover:text-foreground",
                showFloat && "border-primary/40 bg-primary/8 text-primary",
              )}
              onClick={() => setShowFloat((current) => !current)}
              aria-pressed={showFloat}
              title={showFloat ? "隐藏浮动时间" : "显示浮动时间"}
            >
              <span className="inline-block w-4 border-t border-dashed border-current" />
              浮动
            </button>
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
        </div>
      </div>

      <div ref={ganttSurfaceRef} className={cn("relative flex min-h-0 flex-col", fullScreen && "flex-1")}>
        <div
          ref={scrollViewportRef}
          data-testid="gantt-scroll-viewport"
          className={cn(
            "gantt-scroll-viewport min-h-[260px] overflow-x-scroll overflow-y-auto",
            fullScreen ? "min-h-0 flex-1" : "gantt-scroll-viewport-embedded",
          )}
          style={!fullScreen && embeddedViewportHeight ? { height: embeddedViewportHeight } : undefined}
          onScroll={updateVirtualRange}
        >
        <div className="grid min-w-max" style={{ gridTemplateColumns: `${leftWidth}px ${timelineWidth}px` }}>
          <TaskGridHeader
            allSelected={rows.length > 0 && explicitSelectedTaskIds.length === rows.length}
            columnWidths={columnWidths}
            filterOptionsByKey={filterOptionsByKey}
            filters={columnFilters}
            onAutoFitColumn={autoFitColumn}
            onFilterChange={updateColumnFilter}
            onResizeColumn={resizeColumn}
            onToggleAllSelection={toggleAllTaskSelection}
            portalContainer={portalContainer}
            visibleColumnKeys={visibleColumnKeys}
          />
          <TimelineHeader
            config={config}
            visibleDays={visibleDays}
            visibleStartDate={visibleStartDate}
            width={timelineWidth}
          />

          <div
            data-testid="gantt-task-grid-body"
            className="relative z-10 border-r border-border bg-card transition-colors duration-200 hover:border-primary/40"
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
                  canEdit={canEdit}
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
                  hasChildren={childIdsByParentId.has(row.id)}
                  hierarchyCollapsed={collapsedTaskIds.has(row.id)}
                  onToggleHierarchy={() => toggleTaskCollapsed(row.id)}
                  onSequencePointerDown={(event) => selectTaskFromSequence(row.id, index, event)}
                  onSequencePointerEnter={(event) => extendSequenceSelection(index, event.buttons)}
                  onUpdateTask={onUpdateTask}
                  projectMembers={projectMembers}
                  calendarMode={calendarMode}
                  predecessorOptions={tasks}
                  row={row}
                  resourceConflictMessages={resourceConflictMessagesByTaskId[row.id] ?? []}
                  unassignedLeafTasks={unassignedLeafTasksByParentId.get(row.id) ?? []}
                  taskDepth={taskDepthById.get(row.id) ?? 0}
                  explicitSelected={explicitSelectedTaskIds.includes(row.id)}
                  linkedSelected={linkedSelectedTaskIds.includes(row.id)}
                  selectionStart={explicitSelectedTaskIdSet.has(row.id) && !explicitSelectedTaskIdSet.has(visibleRows[index - 1]?.id ?? "")}
                  selectionEnd={explicitSelectedTaskIdSet.has(row.id) && !explicitSelectedTaskIdSet.has(visibleRows[index + 1]?.id ?? "")}
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
              const floatSpanDays = showFloat
                ? floatCalendarSpanDays(row.endDate, row.freeFloatMinutes, calendarMode)
                : 0;
              const floatWidth = config.dayWidth * floatSpanDays;
              const scheduleStatus = row.scheduleStatus as GanttScheduleStatus | undefined;
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
                    title={`${barLabel}: ${row.startDate} ~ ${row.endDate}，当前进度 ${progress}%\n最早 ${row.earlyStartDate || "--"} ~ ${row.earlyFinishDate || "--"}\n最迟 ${row.lateStartDate || "--"} ~ ${row.lateFinishDate || "--"}\n总浮动 ${formatFloat(row.totalFloatMinutes)}，自由浮动 ${formatFloat(row.freeFloatMinutes)}`}
                  >
                    <div
                      className={cn(
                        "h-full rounded-sm",
                        row.isCritical ? "bg-destructive" : "bg-primary"
                      )}
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  {floatWidth > 0 && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute left-full top-1/2 h-0 border-t border-dashed border-sky-400/70"
                      style={{ width: floatWidth }}
                    >
                      <span className="absolute -right-0.5 -top-1 size-1.5 rounded-full bg-sky-400/75" />
                    </span>
                  )}
                  {scheduleStatus === "NEGATIVE_FLOAT" && (
                    <span className="pointer-events-none absolute -right-1 top-0 size-2 rounded-full bg-destructive shadow-[0_0_0_2px_hsl(var(--background))]" />
                  )}
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
        {contextMenu && contextTask && typeof document !== "undefined" && createPortal((
          <div
            role="menu"
            aria-label="甘特任务右键菜单"
            className={cn(
              "gantt-context-menu fixed z-[130] rounded-md border border-border bg-card text-card-foreground shadow-[var(--app-shadow-popover)]",
              contextMenu.x > window.innerWidth / 2 && "gantt-context-menu-open-left",
            )}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="gantt-context-menu-header">
              <div className="truncate font-medium text-foreground">{contextTask.taskCode || "未编号"} · {contextTask.taskName || "未命名任务"}</div>
              <div className="mt-0.5 truncate">已选 {explicitSelectedTaskIds.length} 项，共处理 {selectedCount} 行</div>
            </div>
            <button
              type="button"
              role="menuitem"
              className="gantt-context-menu-item"
              disabled={!canEdit || selectedRootTaskIds.length === 0}
              onClick={() => copyOrCutSelection("MOVE")}
            >
              <Scissors className="size-4 shrink-0" />
              <span>剪切</span>
              <kbd>Ctrl/Cmd+X</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              className="gantt-context-menu-item"
              disabled={!canEdit || explicitSelectedTaskIds.length === 0}
              onClick={() => copyOrCutSelection("COPY")}
            >
              <Copy className="size-4 shrink-0" />
              <span>复制</span>
              <kbd>Ctrl/Cmd+C</kbd>
            </button>
            <div
              className="gantt-context-menu-submenu-anchor"
              onMouseEnter={() => setContextSubmenu("paste")}
              onMouseLeave={() => setContextSubmenu((current) => current === "paste" ? null : current)}
            >
              <button
                type="button"
                role="menuitem"
                className="gantt-context-menu-item"
                disabled={!canEdit || !clipboard || clipboard.projectId !== projectId}
                onClick={() => setContextSubmenu("paste")}
              >
                <ClipboardPaste className="size-4 shrink-0" />
                <span>粘贴</span>
                <MenuChevronRight className="ml-auto size-3.5" />
              </button>
              {contextSubmenu === "paste" && clipboard?.projectId === projectId && (
                <div className="gantt-context-submenu" role="menu" aria-label="粘贴位置">
                  <button type="button" role="menuitem" className="gantt-context-menu-item" disabled={invalidMovePasteTarget} onClick={() => void pasteSelection("BEFORE")}>粘贴到行上方</button>
                  <button type="button" role="menuitem" className="gantt-context-menu-item" disabled={invalidMovePasteTarget} onClick={() => void pasteSelection("AFTER")}>粘贴到行下方</button>
                  {invalidMovePasteTarget && <div className="gantt-context-menu-hint">请选择被剪切分支以外的目标行</div>}
                </div>
              )}
            </div>
            <div className="gantt-context-menu-separator" />
            {canCreate && (
              <div
                className="gantt-context-menu-submenu-anchor"
                onMouseEnter={() => {
                  if (contextSubmenu !== "insert") setInsertCount(1);
                  setContextSubmenu("insert");
                }}
                onMouseLeave={() => setContextSubmenu((current) => current === "insert" ? null : current)}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="gantt-context-menu-item"
                  onClick={() => {
                    if (contextSubmenu !== "insert") setInsertCount(1);
                    setContextSubmenu("insert");
                  }}
                >
                  <Plus className="size-4 shrink-0" />
                  <span>插入</span>
                  <MenuChevronRight className="ml-auto size-3.5" />
                </button>
                {contextSubmenu === "insert" && (
                  <div className="gantt-context-submenu gantt-context-submenu-wide" role="menu" aria-label="插入任务">
                    {([
                      ["SIBLING_BEFORE", "在上方插入", "个同级任务"],
                      ["SIBLING_AFTER", "在下方插入", "个同级任务"],
                      ["CHILD_FIRST", "在上方插入", "个子任务"],
                      ["CHILD_LAST", "在下方插入", "个子任务"],
                    ] as const).map(([placement, prefix, suffix]) => (
                      <button
                        key={placement}
                        type="button"
                        role="menuitem"
                        className="gantt-context-menu-item gantt-context-insert-item"
                        onClick={() => void performInsert(placement)}
                      >
                        <span>{prefix}</span>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          step={1}
                          value={insertCount}
                          aria-label={`${prefix}${suffix}数量`}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                          onChange={(event) => setInsertCount(Math.max(0, Math.min(100, Math.trunc(Number(event.target.value) || 0))))}
                        />
                        <span>{suffix}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {canEdit && (
              <>
                <div className="gantt-context-menu-separator" />
                {contextTaskHasChildren && (
                  <div
                    className="gantt-context-menu-submenu-anchor"
                    onMouseEnter={() => setContextSubmenu("owner")}
                    onMouseLeave={() => setContextSubmenu((current) => current === "owner" ? null : current)}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="gantt-context-menu-item"
                      onClick={() => setContextSubmenu("owner")}
                    >
                      <UserRoundCog className="size-4 shrink-0" />
                      <span>批量改派负责人</span>
                      <MenuChevronRight className="ml-auto size-3.5" />
                    </button>
                    {contextSubmenu === "owner" && (
                      <div className="gantt-context-submenu max-h-72 overflow-y-auto" role="menu" aria-label="批量改派负责人">
                        <button type="button" role="menuitem" className="gantt-context-menu-item" onClick={() => void reassignContextBranch(null)}>未分配</button>
                        {projectMembers.map((member) => (
                          <button key={member.id} type="button" role="menuitem" className="gantt-context-menu-item" onClick={() => void reassignContextBranch(member.id)}>
                            {member.personName}（{member.roleName}）
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="gantt-context-menu-item"
                  onClick={() => void toggleContextMilestone()}
                >
                  <Star className={cn("size-4 shrink-0", contextTask.isMilestone && "fill-current text-amber-400")} />
                  <span>{contextTask.isMilestone ? "取消里程碑标记" : "标记为里程碑"}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="gantt-context-menu-item"
                  disabled={!canOutdentSelection || hierarchyChanging}
                  onClick={() => changeContextHierarchy("OUTDENT")}
                >
                  <IndentDecrease className="size-4 shrink-0" />
                  <span>上移层级</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="gantt-context-menu-item"
                  disabled={!canIndentSelection || hierarchyChanging}
                  onClick={() => changeContextHierarchy("INDENT")}
                >
                  <IndentIncrease className="size-4 shrink-0" />
                  <span>层级下移</span>
                </button>
              </>
            )}
            {canDelete && (
              <>
                <div className="gantt-context-menu-separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="gantt-context-menu-item gantt-context-menu-item-danger"
                  disabled={deletingSelected}
                  onClick={deleteContextTask}
                >
                  <Trash2 className="size-4 shrink-0" />
                  <span>删除</span>
                </button>
              </>
            )}
          </div>
        ), document.fullscreenElement ?? document.body)}
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
        </div>
      </div>

      <div className={cn("gantt-scroll-viewport overflow-x-scroll overflow-y-auto", fullScreen && "min-h-0 flex-1")}>
        <div className="grid min-w-max" style={{ gridTemplateColumns: `${leftWidth}px ${timelineWidth}px` }}>
          <TaskGridHeader
            allSelected={false}
            columnWidths={columnWidths}
            onAutoFitColumn={onAutoFitColumn}
            onResizeColumn={onResizeColumn}
            onToggleAllSelection={() => undefined}
            visibleColumnKeys={visibleColumnKeys}
          />
          <TimelineHeader
            config={config}
            visibleDays={visibleDays}
            visibleStartDate={visibleStartDate}
            width={timelineWidth}
          />

          <div className="relative z-10 flex items-center justify-center border-r border-border bg-background text-xs text-muted-foreground transition-colors duration-200 hover:border-primary/40" style={{ height: bodyHeight }}>
            <GanttDividerToggle
              collapsed={detailsCollapsed}
              onToggle={() => setDetailsCollapsed((prev) => !prev)}
              className="-right-2 top-1/2 -translate-y-1/2"
            />
            <div className="flex flex-col items-center gap-2">
              <span>{emptyText}</span>
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
                  创建首个任务
                </Button>
              )}
            </div>
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
  allSelected,
  columnWidths,
  filterOptionsByKey,
  filters = {},
  onAutoFitColumn,
  onFilterChange,
  onResizeColumn,
  onToggleAllSelection,
  portalContainer,
  visibleColumnKeys,
}: {
  allSelected: boolean;
  columnWidths: GanttColumnWidths;
  filterOptionsByKey?: Record<GanttFilterKey, string[]>;
  filters?: GanttFilterState;
  onAutoFitColumn: (key: GanttColumnKey) => void;
  onFilterChange?: (key: GanttFilterKey, values?: string[]) => void;
  onResizeColumn: (key: GanttColumnKey, width: number) => void;
  onToggleAllSelection: () => void;
  portalContainer?: HTMLElement | null;
  visibleColumnKeys: GanttColumnKey[];
}) => {
  return (
    <div
      data-testid="gantt-task-grid-header"
      className="sticky top-0 z-20 box-border grid items-center border-b border-r border-border bg-muted text-[11px] font-medium text-foreground"
      style={{
        height: HEADER_HEIGHT,
        gridTemplateColumns: visibleColumnKeys.map((key) => `${columnWidths[key]}px`).join(" "),
      }}
    >
      {visibleColumnKeys.map((key) => (
        <div
          key={key}
          data-gantt-column-key={key}
          className={cn("group/column relative flex h-full min-w-0 items-center", key === "sequence" ? "px-0" : "px-2")}
        >
          {key === "sequence" ? (
            <button
              type="button"
              className={cn(
                "flex !h-full !min-h-0 w-full items-center justify-center whitespace-nowrap !rounded-none !border-0 !bg-transparent !p-0 text-[11px] !shadow-none transition-colors hover:!bg-transparent hover:text-primary active:!transform-none",
                allSelected && "text-primary",
              )}
              onClick={onToggleAllSelection}
              aria-label={allSelected ? "取消选择全部任务" : "选择全部任务"}
              title={allSelected ? "取消全选" : "全选（包含折叠任务）"}
            >
              {GANTT_COLUMN_LABELS[key]}
            </button>
          ) : (
            <>
              <span className="min-w-0 truncate whitespace-nowrap">{GANTT_COLUMN_LABELS[key]}</span>
              {filterOptionsByKey && onFilterChange && GANTT_FILTER_KEYS.includes(key as GanttFilterKey) && (
                <GanttColumnFilterMenu
                  columnKey={key as GanttFilterKey}
                  options={filterOptionsByKey[key as GanttFilterKey]}
                  selectedValues={filters[key as GanttFilterKey]}
                  onChange={(values) => onFilterChange(key as GanttFilterKey, values)}
                  portalContainer={portalContainer}
                />
              )}
            </>
          )}
          {key !== "drag" && key !== "sequence" && (
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
  const editedRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!editing) setText(value > 0 ? String(value) : "");
  }, [editing, value]);

  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      editedRef.current = false;
      setEditing(false);
      setText(value > 0 ? String(value) : "");
      return;
    }
    if (!editedRef.current && !text.trim()) {
      setEditing(false);
      setText(value > 0 ? String(value) : "");
      return;
    }
    const next = text.trim() ? normalizeGanttDurationDays(Number(text)) : 0;
    editedRef.current = false;
    setEditing(false);
    setText(next > 0 ? String(next) : "");
    onCommit(next);
  };

  return (
    <Input
      type="text"
      inputMode="decimal"
      value={editing ? text : value > 0 ? String(value) : "--"}
      placeholder={editing && value > 0 ? String(value) : undefined}
      onFocus={() => {
        editedRef.current = false;
        cancelledRef.current = false;
        setEditing(true);
        setText("");
      }}
      onChange={(event) => {
        const next = event.target.value.replace(/[^\d.]/g, "");
        if (/^\d*(?:\.\d*)?$/.test(next)) {
          editedRef.current = true;
          setText(next);
        }
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if ((event.key === "Backspace" || event.key === "Delete") && !text) {
          editedRef.current = true;
        }
        if (event.key === "Escape") {
          cancelledRef.current = true;
          event.currentTarget.blur();
        }
      }}
      className={cn(durationFieldClass, "placeholder:text-muted-foreground/45")}
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
  canEdit,
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
  onSequencePointerDown,
  onSequencePointerEnter,
  onToggleHierarchy,
  onUpdateTask,
  predecessorOptions,
  projectMembers,
  row,
  resourceConflictMessages,
  unassignedLeafTasks,
  taskDepth,
  visualTop,
  explicitSelected,
  linkedSelected,
  selectionStart,
  selectionEnd,
  columnWidths,
  portalContainer,
  visibleColumnKeys,
}: {
  calendarMode: GanttCalendarMode;
  canEdit: boolean;
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
  onSequencePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onSequencePointerEnter: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onToggleHierarchy: () => void;
  onUpdateTask?: (task: ProjectGanttTask, draft: GanttTaskDraft, columnKey?: string) => void | Promise<void>;
  predecessorOptions: ProjectGanttTask[];
  projectMembers: ProjectMember[];
  row: ReturnType<typeof buildGanttRows>[number];
  resourceConflictMessages: string[];
  unassignedLeafTasks: Array<ReturnType<typeof buildGanttRows>[number]>;
  taskDepth: number;
  visualTop: number;
  explicitSelected: boolean;
  linkedSelected: boolean;
  selectionStart: boolean;
  selectionEnd: boolean;
  columnWidths: GanttColumnWidths;
  portalContainer?: HTMLElement | null;
  visibleColumnKeys: GanttColumnKey[];
}) => {
  const [draft, setDraft] = useState<GanttTaskDraft>(() => toTaskDraft(row, calendarMode));
  const isColumnVisible = (key: GanttColumnKey) => visibleColumnKeys.includes(key);
  const isChildTask = taskDepth > 0;
  const ownerMembers = row.ownerMembers ?? (row.ownerMember ? [row.ownerMember] : []);
  const ownerNames = ownerMembers.map((owner) => owner.personName);
  const ownerSelectValue = draft.ownerMemberIds?.length
    ? draft.ownerMemberIds
    : ownerMembers.length > 0
      ? ownerMembers.map((owner) => owner.id)
      : draft.ownerMemberId ? [draft.ownerMemberId] : [];
  const ownerSelectOptions = projectMembers.map((member) => ({
    id: member.id,
    label: member.personName,
    secondaryLabel: member.roleNames?.length ? member.roleNames.join("、") : member.roleName,
    searchText: [member.personName, ...(member.roleNames ?? [member.roleName])].filter(Boolean).join(" "),
  }));
  const ownerReadOnly = Boolean(row.ownerReadOnly);
  const hasUnassignedLeafTasks = unassignedLeafTasks.length > 0;
  const hasResourceConflict = resourceConflictMessages.length > 0;
  const levelColor = GANTT_DEPTH_COLORS[taskDepth % GANTT_DEPTH_COLORS.length];
  const levelCycle = Math.floor(taskDepth / GANTT_DEPTH_COLORS.length);
  const levelLightness = Math.max(42, levelColor.lightness - levelCycle * 6);
  const levelRowStyle = {
    "--gantt-level-row": `hsl(${levelColor.hue} ${levelColor.saturation}% ${levelLightness}% / ${hasChildren ? 0.11 : 0.06})`,
    "--gantt-level-hover": `hsl(${levelColor.hue} ${levelColor.saturation}% ${levelLightness}% / ${hasChildren ? 0.17 : 0.12})`,
    "--gantt-level-accent": `hsl(${levelColor.hue} ${levelColor.saturation}% ${levelLightness}% / 0.68)`,
  } as CSSProperties & Record<"--gantt-level-row" | "--gantt-level-hover" | "--gantt-level-accent", string>;

  const updateDraft = <K extends keyof GanttTaskDraft>(key: K, value: GanttTaskDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const updateTaskName = (value: string) => {
    updateDraft("taskName", value.replace(/【关键路径】/g, "").replace(/【关键路径/g, "").replace(/关键路径】/g, ""));
  };

  const commitDraft = (columnKey?: GanttColumnKey) => {
    if (!canEdit || taskDraftEquals(row, draft, calendarMode)) return;
    void onUpdateTask?.(row, draft, columnKey);
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
    columnKey: GanttColumnKey,
  ) => {
    const nextDraft = builder(draft, value);
    setDraft(nextDraft);
    if (canEdit && !taskDraftEquals(row, nextDraft, calendarMode)) {
      void onUpdateTask?.(row, nextDraft, columnKey);
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
      data-gantt-task-id={row.id}
      className={cn(
        "group relative box-border grid cursor-default items-center border-b border-border text-xs transition-[background,box-shadow,transform] duration-150",
        "bg-[var(--gantt-level-row)] hover:bg-[var(--gantt-level-hover)]",
        row.isCritical
          ? "shadow-[inset_3px_0_0_hsl(var(--destructive))]"
          : "shadow-[inset_2px_0_0_var(--gantt-level-accent)]",
        explicitSelected && "!bg-sky-500/12 hover:!bg-sky-500/16",
        linkedSelected && "!bg-sky-500/8 hover:!bg-sky-500/12",
        dragged && "scale-[0.995] opacity-45 shadow-lg",
        dropPosition && "!bg-primary/10",
        hasChildren && "font-semibold",
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
      {explicitSelected && (
        <span
          aria-hidden="true"
          data-gantt-selection-outline="true"
          className={cn(
            "pointer-events-none absolute inset-0 z-[12] border-x-2 border-sky-400/90",
            selectionStart && "border-t-2",
            selectionEnd && "border-b-2",
          )}
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
      <button
        type="button"
        data-gantt-column-key="sequence"
        className={cn(
          "flex !h-full !min-h-0 w-full select-none items-center justify-center !rounded-none !border-0 !bg-transparent !p-0 font-mono text-[11px] tabular-nums text-muted-foreground !shadow-none transition-colors hover:!bg-transparent active:!transform-none",
          explicitSelected && "font-semibold text-primary",
          linkedSelected && "cursor-not-allowed text-primary/55",
        )}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onSequencePointerDown(event);
        }}
        onPointerEnter={onSequencePointerEnter}
        aria-label={`选择第 ${index + 1} 行`}
        aria-pressed={explicitSelected || linkedSelected}
        title={linkedSelected ? "由父任务联动选择" : "点击选择，Shift 连选，Ctrl/Cmd 多选"}
      >
        {index + 1}
      </button>
      <span
        data-gantt-column-key="drag"
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
      <div data-gantt-column-key="taskCode" className="relative flex min-w-0 items-center gap-1 px-2" style={{ paddingLeft: `${8 + taskDepth * 10}px` }}>
        {hasUnassignedLeafTasks && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex size-4 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-muted-foreground/75 outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
                aria-label={`${draft.taskName || row.taskCode || "父任务"}存在 ${unassignedLeafTasks.length} 个未分配负责人任务`}
                onClick={(event) => event.stopPropagation()}
              >
                <TriangleAlert className="size-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              align="start"
              className="max-h-64 max-w-[min(420px,calc(100vw-2rem))] overflow-y-auto px-3 py-2 leading-5"
            >
              <div className="font-medium">以下任务未安排负责人</div>
              <ul className="mt-1 space-y-0.5 text-card-foreground">
                {unassignedLeafTasks.map((task) => (
                  <li key={task.id} className="break-words">
                    {task.taskCode || "未编号"} · {task.taskName || "未命名任务"}
                  </li>
                ))}
              </ul>
            </TooltipContent>
          </Tooltip>
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
        {row.isMilestone && (
          <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="里程碑" />
        )}
        <span
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap pr-12 font-mono text-[11px] font-semibold text-[var(--gantt-level-accent)]"
          title={row.taskCode || row.id}
        >
          {row.taskCode || `Task${index + 1}`}
        </span>
      </div>
      {isColumnVisible("taskCategory") && (
        <div
          data-gantt-column-key="taskCategory"
          className="flex min-w-0 items-center truncate px-2 text-xs text-foreground"
          title={draft.taskCategory || "无"}
          aria-label={`任务类别：${draft.taskCategory || "无"}`}
        >
          {draft.taskCategory || "无"}
        </div>
      )}
      <div data-gantt-column-key="taskName" className="relative min-w-0">
        <Input
          value={draft.taskName}
          onBlur={() => commitDraft("taskName")}
          onChange={(event) => updateTaskName(event.target.value)}
          onKeyDown={handleKeyDown}
          className={cn(
            inlineFieldClass,
            hasChildren ? "font-semibold" : "font-medium",
            draft.progress >= 100 && "line-through decoration-1 text-muted-foreground",
            row.isCritical && "text-destructive",
            row.isCritical && "pr-[76px]",
          )}
          disabled={!canEdit || isSaving}
          style={{ paddingLeft: `${8 + taskDepth * 18}px` }}
          placeholder="任务名称"
          title={row.scheduleStatus === "NEGATIVE_FLOAT" ? `${draft.taskName}【负浮动】` : row.isCritical ? `${draft.taskName}【关键路径】` : draft.taskName}
        />
        {row.isCritical && (
          <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] font-medium text-destructive">
            {row.scheduleStatus === "NEGATIVE_FLOAT" ? "【负浮动】" : "【关键路径】"}
          </span>
        )}
      </div>
      {isColumnVisible("taskDescription") && (draft.taskDescription.trim() ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div data-gantt-column-key="taskDescription" className="min-w-0">
              <Input
                value={draft.taskDescription}
                onBlur={() => commitDraft("taskDescription")}
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
          data-gantt-column-key="taskDescription"
          value={draft.taskDescription}
          onBlur={() => commitDraft("taskDescription")}
          onChange={(event) => updateDraft("taskDescription", event.target.value)}
          onKeyDown={handleKeyDown}
          className={inlineFieldClass}
          disabled={!canEdit || isSaving}
          placeholder="任务描述"
          aria-label="任务描述"
        />
      ))}
      {isColumnVisible("owner") && (
        <div data-gantt-column-key="owner" className="relative min-w-0">
          <HierarchicalMultiSelect
            options={ownerSelectOptions}
            value={ownerSelectValue}
            ariaLabel="负责人"
            searchPlaceholder="搜索项目成员或角色"
            emptyText="没有可选择的项目成员"
            placeholder="未分配"
            title={ownerReadOnly ? `已汇总 ${ownerNames.length} 名子任务负责人，请先调整子任务` : ownerNames.join("、") || "未分配"}
            onChange={(ownerMemberIds) => {
              const normalizedOwnerMemberIds = [...new Set(ownerMemberIds)];
              const nextDraft = {
                ...draft,
                ownerMemberIds: normalizedOwnerMemberIds,
                ownerMemberId: normalizedOwnerMemberIds.length === 1 ? normalizedOwnerMemberIds[0] : null,
              };
              setDraft(nextDraft);
              if (canEdit && !taskDraftEquals(row, nextDraft, calendarMode)) {
                void onUpdateTask?.(row, nextDraft, "owner");
              }
            }}
            applyOnClose
            className={cn(inlineSelectClass, "text-left", hasResourceConflict && "pr-6")}
            contentClassName="w-[360px]"
            portalContainer={portalContainer}
            disabled={!canEdit || isSaving || ownerReadOnly}
          />
          {hasResourceConflict && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="absolute right-1 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center border-0 bg-transparent p-0 text-muted-foreground/75 outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
                  aria-label={`${draft.taskName || row.taskCode || "任务"}存在资源冲突`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <TriangleAlert className="size-3.5" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" align="end" className="max-h-64 max-w-[min(480px,calc(100vw-2rem))] overflow-y-auto px-3 py-2 leading-5">
                <div className="font-medium text-destructive">资源冲突</div>
                <ul className="mt-1 space-y-1 text-card-foreground">
                  {resourceConflictMessages.map((message) => <li key={message} className="break-words">{message}</li>)}
                </ul>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
      {isColumnVisible("durationDays") && (
        <div data-gantt-column-key="durationDays">
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
                void onUpdateTask?.(row, nextDraft, "durationDays");
              }
            }}
          />
        </div>
      )}
      {isColumnVisible("startDate") && (
        <div data-gantt-column-key="startDate">
          <GanttDateField
            value={draft.startDate}
            onChange={(value) => updateDateDraft(withPlannedStart, value)}
            onCommit={(value) => commitDateDraft(withPlannedStart, value, "startDate")}
            disabled={!canEdit || isSaving}
            ariaLabel="计划开始"
            required
          />
        </div>
      )}
      {isColumnVisible("endDate") && (
        <div data-gantt-column-key="endDate">
          <GanttDateField
            value={draft.endDate}
            onChange={(value) => updateDateDraft(withPlannedEnd, value)}
            onCommit={(value) => commitDateDraft(withPlannedEnd, value, "endDate")}
            disabled={!canEdit || isSaving}
            ariaLabel="计划完成"
            min={draft.startDate}
            required={draft.durationDays > 0}
          />
        </div>
      )}
      {isColumnVisible("actualStartDate") && (
        <div data-gantt-column-key="actualStartDate">
          <GanttDateField
            value={draft.actualStartDate}
            onChange={(value) => updateDateDraft(withActualStart, value)}
            onCommit={(value) => commitDateDraft(withActualStart, value, "actualStartDate")}
            disabled={!canEdit || isSaving}
            ariaLabel="实际开始"
          />
        </div>
      )}
      {isColumnVisible("actualEndDate") && (
        <div data-gantt-column-key="actualEndDate">
          <GanttDateField
            value={draft.actualEndDate}
            onChange={(value) => updateDateDraft(withActualEnd, value)}
            onCommit={(value) => commitDateDraft(withActualEnd, value, "actualEndDate")}
            disabled={!canEdit || isSaving}
            ariaLabel="实际完成"
            min={draft.actualStartDate || undefined}
          />
        </div>
      )}
      {isColumnVisible("estimatedWorkHours") && (
          <Input
            data-gantt-column-key="estimatedWorkHours"
            type="text"
            value={draft.estimatedWorkHours > 0 ? roundGanttHours(draft.estimatedWorkHours).toFixed(2) : "--"}
            className={durationFieldClass}
            readOnly
            aria-label="预计工时"
            title="按工期 × 7.5 小时自动计算"
          />
      )}
      {isColumnVisible("actualWorkHours") && (
        <div data-gantt-column-key="actualWorkHours">
          <ActualWorkHoursInput
            value={draft.actualWorkHours}
            disabled={!canEdit || isSaving}
            onCommit={(value) => {
              const nextDraft = { ...draft, actualWorkHours: value };
              setDraft(nextDraft);
              if (canEdit && !taskDraftEquals(row, nextDraft, calendarMode)) {
                void onUpdateTask?.(row, nextDraft, "actualWorkHours");
              }
            }}
          />
        </div>
      )}
      {isColumnVisible("progress") && (
          <div data-gantt-column-key="progress" className="flex min-w-0 items-center gap-1">
            <Input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={draft.progress}
              onBlur={() => commitDraft("progress")}
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
      {isColumnVisible("totalFloat") && (
        <div
          data-gantt-column-key="totalFloat"
          className={cn(
            "flex min-w-0 items-center justify-end px-2 font-mono text-[11px] tabular-nums",
            row.totalFloatMinutes != null && row.totalFloatMinutes < 0 && "font-semibold text-destructive",
            row.totalFloatMinutes === 0 && "font-semibold text-destructive",
            row.scheduleStatus === "NEAR_CRITICAL" && "text-amber-500",
          )}
          title={`总浮动：${formatFloat(row.totalFloatMinutes)}`}
        >
          {formatFloat(row.totalFloatMinutes)}
        </div>
      )}
      {isColumnVisible("freeFloat") && (
        <div data-gantt-column-key="freeFloat" className="flex min-w-0 items-center justify-end px-2 font-mono text-[11px] tabular-nums" title={`自由浮动：${formatFloat(row.freeFloatMinutes)}`}>
          {formatFloat(row.freeFloatMinutes)}
        </div>
      )}
      {isColumnVisible("earlyStart") && (
        <div data-gantt-column-key="earlyStart" className="truncate px-2 font-mono text-[11px]" title={row.earlyStartDate || "--"}>{row.earlyStartDate || "--"}</div>
      )}
      {isColumnVisible("earlyFinish") && (
        <div data-gantt-column-key="earlyFinish" className="truncate px-2 font-mono text-[11px]" title={row.earlyFinishDate || "--"}>{row.earlyFinishDate || "--"}</div>
      )}
      {isColumnVisible("lateStart") && (
        <div data-gantt-column-key="lateStart" className="truncate px-2 font-mono text-[11px]" title={row.lateStartDate || "--"}>{row.lateStartDate || "--"}</div>
      )}
      {isColumnVisible("lateFinish") && (
        <div data-gantt-column-key="lateFinish" className="truncate px-2 font-mono text-[11px]" title={row.lateFinishDate || "--"}>{row.lateFinishDate || "--"}</div>
      )}
      {isColumnVisible("scheduleStatus") && (
        <div
          data-gantt-column-key="scheduleStatus"
          className={cn(
            "truncate px-2 text-[11px]",
            row.scheduleStatus === "NEGATIVE_FLOAT" && "font-semibold text-destructive",
            row.scheduleStatus === "CRITICAL" && "text-destructive",
            row.scheduleStatus === "NEAR_CRITICAL" && "text-amber-500",
          )}
          title={SCHEDULE_STATUS_LABELS[(row.scheduleStatus as GanttScheduleStatus) || "UNSCHEDULED"]}
        >
          {SCHEDULE_STATUS_LABELS[(row.scheduleStatus as GanttScheduleStatus) || "UNSCHEDULED"]}
        </div>
      )}
      {isColumnVisible("predecessor") && (
        <div data-gantt-column-key="predecessor">
          <PredecessorSelect
            value={draft.predecessorTaskIds}
            onChange={(predecessorTaskIds) => {
              const nextDraft = { ...draft, predecessorTaskIds };
              setDraft(nextDraft);
              if (canEdit && !taskDraftEquals(row, nextDraft, calendarMode)) {
                void onUpdateTask?.(row, nextDraft, "predecessor");
              }
            }}
            options={predecessorOptions}
            currentTaskId={row.id}
            disabled={!canEdit || isSaving}
            portalContainer={portalContainer}
          />
        </div>
      )}
      {isColumnVisible("remark") && (
        <Input
          data-gantt-column-key="remark"
          value={draft.remark}
          onBlur={() => commitDraft("remark")}
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
  const selectOptions = useMemo<HierarchicalSelectOption[]>(
    () => options
      .filter((task) => task.taskName.trim())
      .filter((task) => {
        if (task.id === currentTaskId) return false;
        let parentId = task.parentId ?? null;
        const descendants = new Set<string>();
        while (parentId) {
          if (parentId === currentTaskId) return false;
          if (descendants.has(parentId)) break;
          descendants.add(parentId);
          parentId = options.find((candidate) => candidate.id === parentId)?.parentId ?? null;
        }
        return true;
      })
      .map((task) => ({
        id: task.id,
        label: task.taskCode || "未编号",
        secondaryLabel: task.taskName,
        searchText: task.taskCategory,
        parentId: task.parentId ?? null,
      })),
    [currentTaskId, options],
  );

  return (
    <HierarchicalMultiSelect
      ariaLabel="紧前任务"
      searchPlaceholder="搜索任务 ID、名称或类别"
      emptyText="没有可选择的紧前任务"
      options={selectOptions}
      value={value}
      onChange={onChange}
      applyOnClose
      disabled={disabled}
      className={cn(inlineSelectClass, "text-left")}
      contentClassName="w-[400px]"
      portalContainer={portalContainer}
    />
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
