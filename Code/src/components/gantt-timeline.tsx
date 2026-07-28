"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, CornerDownRight, GripVertical, IndentDecrease, IndentIncrease, ListTree, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { GanttDateField } from "@/components/gantt-date-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ProjectGanttTask } from "@/domain/models";
import type { GanttHierarchyDirection } from "@/lib/gantt-hierarchy";
import {
  GANTT_COLLAPSED_COLUMN_KEYS,
  GANTT_COLUMN_LABELS,
  GANTT_COLUMN_MIN_WIDTHS,
  GANTT_EXPANDED_COLUMN_KEYS,
  fitGanttColumnWidth,
  fitGanttColumnWidths,
  ganttColumnTemplate,
  ganttColumnsWidth,
  ganttTaskDepths,
  type GanttColumnKey,
  type GanttColumnWidths,
} from "@/lib/gantt-column-layout";
import {
  addCalendarDays,
  addDaysInclusive,
  buildGanttDependencyLinks,
  buildGanttRows,
  diffDays,
  diffDaysInclusive,
  getGanttDateRange,
  parseGanttDate,
} from "@/lib/gantt";
import { cn } from "@/lib/utils";

interface GanttTimelineProps {
  tasks: ProjectGanttTask[];
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
  onCreateTask?: (parentTask?: ProjectGanttTask) => void;
  onUpdateTask?: (task: ProjectGanttTask, draft: GanttTaskDraft) => void | Promise<void>;
  onDeleteSelected?: (taskIds: string[]) => void | Promise<void>;
  onChangeHierarchy?: (taskIds: string[], direction: GanttHierarchyDirection) => void | Promise<void>;
  onReorderTasks?: (taskIds: string[]) => void | Promise<void>;
}

export type GanttTaskDraft = {
  parentId?: string | null;
  taskCategory: string;
  taskName: string;
  startDate: string;
  endDate: string;
  durationDays: number;
  actualStartDate: string;
  actualEndDate: string;
  estimatedWorkHours: number;
  actualWorkHours: number;
  progress: number;
  predecessorTaskIds: string[];
};

const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 32;
const BAR_HEIGHT = 10;
const MIN_TIMELINE_WIDTH = 860;
const ZOOM_LEVELS = [1, 3, 8, 20, 60];
const ZOOM_LABELS = ["60天", "30天", "15天", "5天", "1天"];
const DEFAULT_ZOOM_INDEX = 2;
type DropPosition = "before" | "after";

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

const toTaskDraft = (task: ProjectGanttTask): GanttTaskDraft => ({
  parentId: task.parentId ?? null,
  taskCategory: task.taskCategory,
  taskName: task.taskName,
  startDate: task.startDate,
  endDate: task.finishDate || addDaysInclusive(task.startDate, task.durationDays),
  durationDays: task.durationDays,
  actualStartDate: task.actualStartDate ?? "",
  actualEndDate: task.actualEndDate ?? "",
  estimatedWorkHours: Math.max(0, task.estimatedWorkHours ?? 0),
  actualWorkHours: Math.max(0, task.actualWorkHours ?? 0),
  progress: Math.min(100, Math.max(0, task.progress ?? 0)),
  predecessorTaskIds: task.predecessorTaskIds ?? [],
});

const taskDraftEquals = (task: ProjectGanttTask, draft: GanttTaskDraft) => (
  task.taskCategory === draft.taskCategory
    && task.taskName === draft.taskName
    && task.startDate === draft.startDate
    && (task.finishDate || addDaysInclusive(task.startDate, task.durationDays)) === draft.endDate
    && task.durationDays === draft.durationDays
    && (task.actualStartDate ?? "") === draft.actualStartDate
    && (task.actualEndDate ?? "") === draft.actualEndDate
    && (task.estimatedWorkHours ?? 0) === draft.estimatedWorkHours
    && (task.actualWorkHours ?? 0) === draft.actualWorkHours
    && (task.progress ?? 0) === draft.progress
    && JSON.stringify(task.predecessorTaskIds ?? []) === JSON.stringify(draft.predecessorTaskIds)
    && (task.parentId ?? null) === (draft.parentId ?? null)
);

export const GanttTimeline = ({
  tasks,
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
  const [hoverCollapse, setHoverCollapse] = useState(false);
  const [columnWidths, setColumnWidths] = useState<GanttColumnWidths>({ ...GANTT_COLUMN_MIN_WIDTHS });
  const manuallySizedColumns = useRef(new Set<GanttColumnKey>());
  const [collapsedTaskIds, setCollapsedTaskIds] = useState<Set<string>>(() => new Set());
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
    if (!viewport) return;
    const overscan = 10;
    const bodyScrollTop = Math.max(0, viewport.scrollTop - HEADER_HEIGHT);
    const start = Math.max(0, Math.floor(bodyScrollTop / ROW_HEIGHT) - overscan);
    const visibleCount = Math.ceil(viewport.clientHeight / ROW_HEIGHT) + overscan * 2;
    const end = Math.min(visibleRows.length, start + visibleCount);
    setVirtualRange((current) => current.start === start && current.end === end ? current : { start, end });
  }, [visibleRows.length]);

  useEffect(() => {
    updateVirtualRange();
    const viewport = scrollViewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateVirtualRange);
    observer.observe(viewport);
    return () => observer.disconnect();
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
        setZoomIndex={setZoomIndex}
        setDetailsCollapsed={setDetailsCollapsed}
        columnWidths={columnWidths}
        onAutoFitColumn={autoFitColumn}
        onResizeColumn={resizeColumn}
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
  const leftWidth = ganttColumnsWidth(columnWidths, detailsCollapsed);
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
          {parentDepths.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs">
                  <ListTree className="size-3.5" />
                  折叠层级
                  <ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
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

      <div
        ref={scrollViewportRef}
        className={cn(
          "min-h-[260px] overflow-auto",
          fullScreen ? "min-h-0 flex-1" : "max-h-[calc(100vh-240px)]",
        )}
        onScroll={updateVirtualRange}
      >
        <div className="grid min-w-max" style={{ gridTemplateColumns: `${leftWidth}px ${timelineWidth}px` }}>
          <TaskGridHeader
            collapsed={detailsCollapsed}
            columnWidths={columnWidths}
            onAutoFitColumn={autoFitColumn}
            onResizeColumn={resizeColumn}
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
            <button
              type="button"
              className={cn(
                "absolute right-0 top-0 z-[75] flex !h-full !min-h-0 !w-3 cursor-pointer items-center justify-start !rounded-none !border-0 !p-0 !shadow-none transition-all duration-200",
                hoverCollapse ? "!bg-primary/5" : "!bg-transparent"
              )}
              onMouseEnter={() => setHoverCollapse(true)}
              onMouseLeave={() => setHoverCollapse(false)}
              onClick={() => setDetailsCollapsed((prev) => !prev)}
              title={detailsCollapsed ? "展开列" : "折叠列"}
              aria-label={detailsCollapsed ? "展开列" : "折叠列"}
            >
              <div className={cn(
                "flex h-8 w-3 -translate-x-1 items-center justify-center rounded-l-sm border-l border-transparent bg-card/95 transition-all duration-200",
                hoverCollapse ? "opacity-100" : "opacity-0"
              )}>
                {detailsCollapsed ? <ChevronRight className="h-2.5 w-2.5 text-primary/70" /> : <ChevronLeft className="h-2.5 w-2.5 text-primary/70" />}
              </div>
            </button>
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
                  predecessorOptions={tasks}
                  row={row}
                  taskDepth={taskDepthById.get(row.id) ?? 0}
                  selected={selectedTaskIds.includes(row.id)}
                  selectionLocked={isSelectedByAncestor(row.id)}
                  selectionMode={selectionMode}
                  collapsed={detailsCollapsed}
                  columnWidths={columnWidths}
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
                if (!from || !to) return null;
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
              const left = diffDays(visibleStartDate, row.startDate) * config.dayWidth;
              const width = config.dayWidth * Math.max(1, row.durationDays);
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
    </div>
  );
};

const EmptyGanttTimeline = ({
  canCreate,
  creatingParentId,
  dayWidth,
  zoomIndex,
  detailsCollapsed,
  columnWidths,
  emptyText,
  onAutoFitColumn,
  onCreateTask,
  onResizeColumn,
  setZoomIndex,
  setDetailsCollapsed,
}: {
  canCreate: boolean;
  creatingParentId: string | null;
  dayWidth: number;
  zoomIndex: number;
  detailsCollapsed: boolean;
  columnWidths: GanttColumnWidths;
  emptyText: string;
  onAutoFitColumn: (key: GanttColumnKey) => void;
  onCreateTask?: (parentTask?: ProjectGanttTask) => void;
  onResizeColumn: (key: GanttColumnKey, width: number) => void;
  setZoomIndex: (value: number | ((prev: number) => number)) => void;
  setDetailsCollapsed: (value: boolean | ((prev: boolean) => boolean)) => void;
}) => {
  const config = { dayWidth, tickEvery: getTickEvery(dayWidth) };
  const visibleStartDate = new Date().toISOString().slice(0, 10);
  const visibleDays = 28;
  const timelineWidth = Math.max(MIN_TIMELINE_WIDTH, visibleDays * config.dayWidth);
  const leftWidth = ganttColumnsWidth(columnWidths, detailsCollapsed);
  const bodyHeight = ROW_HEIGHT * 3;
  const [hoverCollapse, setHoverCollapse] = useState(false);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
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

      <div className="overflow-auto">
        <div className="grid min-w-max" style={{ gridTemplateColumns: `${leftWidth}px ${timelineWidth}px` }}>
          <TaskGridHeader
            collapsed={detailsCollapsed}
            columnWidths={columnWidths}
            onAutoFitColumn={onAutoFitColumn}
            onResizeColumn={onResizeColumn}
          />
          <TimelineHeader
            config={config}
            visibleDays={visibleDays}
            visibleStartDate={visibleStartDate}
            width={timelineWidth}
          />

          <div className="sticky left-0 z-10 flex items-center justify-center border-r border-border bg-background text-xs text-muted-foreground transition-colors duration-200 hover:border-primary/40" style={{ height: bodyHeight }}>
            <button
              type="button"
              className={cn(
                "absolute right-0 top-0 z-[75] flex !h-full !min-h-0 !w-3 cursor-pointer items-center justify-start !rounded-none !border-0 !p-0 !shadow-none transition-all duration-200",
                hoverCollapse ? "!bg-primary/5" : "!bg-transparent"
              )}
              onMouseEnter={() => setHoverCollapse(true)}
              onMouseLeave={() => setHoverCollapse(false)}
              onClick={() => setDetailsCollapsed((prev) => !prev)}
              title={detailsCollapsed ? "展开列" : "折叠列"}
              aria-label={detailsCollapsed ? "展开列" : "折叠列"}
            >
              <div className={cn(
                "flex h-8 w-3 -translate-x-1 items-center justify-center rounded-l-sm border-l border-transparent bg-card/95 transition-all duration-200",
                hoverCollapse ? "opacity-100" : "opacity-0"
              )}>
                {detailsCollapsed ? <ChevronRight className="h-2.5 w-2.5 text-primary/70" /> : <ChevronLeft className="h-2.5 w-2.5 text-primary/70" />}
              </div>
            </button>
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
  collapsed,
  columnWidths,
  onAutoFitColumn,
  onResizeColumn,
}: {
  collapsed: boolean;
  columnWidths: GanttColumnWidths;
  onAutoFitColumn: (key: GanttColumnKey) => void;
  onResizeColumn: (key: GanttColumnKey, width: number) => void;
}) => {
  const keys = collapsed ? GANTT_COLLAPSED_COLUMN_KEYS : GANTT_EXPANDED_COLUMN_KEYS;
  return (
    <div
      className="sticky top-0 left-0 z-20 box-border grid items-center border-b border-r border-border bg-muted text-[11px] font-medium text-foreground"
      style={{
        height: HEADER_HEIGHT,
        gridTemplateColumns: ganttColumnTemplate(columnWidths, collapsed),
      }}
    >
      {keys.map((key) => (
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

const EditableTaskRow = ({
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
  onStartChild,
  onToggleHierarchy,
  onToggleSelected,
  onUpdateTask,
  predecessorOptions,
  row,
  taskDepth,
  visualTop,
  selected,
  selectionLocked,
  selectionMode,
  collapsed,
  columnWidths,
}: {
  canCreate: boolean;
  canEdit: boolean;
  collapsed: boolean;
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
  onStartChild?: () => void;
  onToggleHierarchy: () => void;
  onToggleSelected: () => void;
  onUpdateTask?: (task: ProjectGanttTask, draft: GanttTaskDraft) => void | Promise<void>;
  predecessorOptions: ProjectGanttTask[];
  row: ReturnType<typeof buildGanttRows>[number];
  taskDepth: number;
  visualTop: number;
  selected: boolean;
  selectionLocked: boolean;
  selectionMode: boolean;
  columnWidths: GanttColumnWidths;
}) => {
  const [draft, setDraft] = useState<GanttTaskDraft>(() => toTaskDraft(row));
  const isChildTask = taskDepth > 0;

  const updateDraft = <K extends keyof GanttTaskDraft>(key: K, value: GanttTaskDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const updateTaskName = (value: string) => {
    updateDraft("taskName", value.replace(/【关键路径】/g, "").replace(/【关键路径/g, "").replace(/关键路径】/g, ""));
  };

  const commitDraft = () => {
    if (!canEdit || taskDraftEquals(row, draft)) return;
    void onUpdateTask?.(row, draft);
  };

  const withPlannedStart = (current: GanttTaskDraft, value: string): GanttTaskDraft => ({
    ...current,
    startDate: value,
    endDate: value ? addDaysInclusive(value, current.durationDays) : current.endDate,
  });

  const withPlannedEnd = (current: GanttTaskDraft, value: string): GanttTaskDraft => ({
    ...current,
    endDate: value,
    durationDays: current.startDate && value
      ? diffDaysInclusive(current.startDate, value)
      : current.durationDays,
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
    if (canEdit && !taskDraftEquals(row, nextDraft)) {
      void onUpdateTask?.(row, nextDraft);
    }
  };

  useEffect(() => {
    setDraft(toTaskDraft(row));
  }, [row]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
    if (event.key === "Escape") {
      setDraft(toTaskDraft(row));
      event.currentTarget.blur();
    }
  };

  return (
    <div
      className={cn(
        "group relative box-border grid cursor-default items-center border-b border-border text-xs transition-[background,box-shadow,transform] duration-150",
        isChildTask ? "bg-primary/5" : index % 2 === 0 ? "bg-background" : "bg-muted/25",
        row.isCritical
          ? "shadow-[inset_3px_0_0_hsl(var(--destructive))]"
          : isChildTask && "shadow-[inset_3px_0_0_hsl(var(--primary))]",
        selected && "bg-primary/15",
        dragged && "scale-[0.995] opacity-45 shadow-lg",
        dropPosition && "bg-primary/10",
        "hover:bg-primary/10"
      )}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      style={{
        position: "absolute",
        insetInline: 0,
        top: visualTop,
        height: ROW_HEIGHT,
        gridTemplateColumns: ganttColumnTemplate(columnWidths, collapsed),
        contentVisibility: dropPosition || dragged ? "visible" : "auto",
        containIntrinsicSize: `${ROW_HEIGHT}px`,
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
        {isChildTask && <span className="h-px w-2 shrink-0 bg-primary/60" />}
        <span
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap pr-12 font-mono text-[11px] font-semibold text-muted-foreground"
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
      {!collapsed && (
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
      {!collapsed && (
        <>
          <Input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={draft.durationDays}
            onBlur={commitDraft}
            onChange={(event) => {
              const digits = event.target.value.replace(/\D/g, "");
              const durationDays = digits ? Number(digits) : 1;
              setDraft((current) => ({
                ...current,
                durationDays,
                endDate: current.startDate ? addDaysInclusive(current.startDate, durationDays) : current.endDate,
              }));
            }}
            onKeyDown={handleKeyDown}
            className={durationFieldClass}
            disabled={!canEdit || isSaving}
            aria-label="工期天数"
          />
          <GanttDateField
            value={draft.startDate}
            onChange={(value) => updateDateDraft(withPlannedStart, value)}
            onCommit={(value) => commitDateDraft(withPlannedStart, value)}
            disabled={!canEdit || isSaving}
            ariaLabel="计划开始"
            required
          />
          <GanttDateField
            value={draft.endDate}
            onChange={(value) => updateDateDraft(withPlannedEnd, value)}
            onCommit={(value) => commitDateDraft(withPlannedEnd, value)}
            disabled={!canEdit || isSaving}
            ariaLabel="计划完成"
            min={draft.startDate}
            required
          />
          <GanttDateField
            value={draft.actualStartDate}
            onChange={(value) => updateDateDraft(withActualStart, value)}
            onCommit={(value) => commitDateDraft(withActualStart, value)}
            disabled={!canEdit || isSaving}
            ariaLabel="实际开始"
          />
          <GanttDateField
            value={draft.actualEndDate}
            onChange={(value) => updateDateDraft(withActualEnd, value)}
            onCommit={(value) => commitDateDraft(withActualEnd, value)}
            disabled={!canEdit || isSaving}
            ariaLabel="实际完成"
            min={draft.actualStartDate || undefined}
          />
          <Input
            type="number"
            min={0}
            step="0.5"
            value={draft.estimatedWorkHours}
            onBlur={commitDraft}
            onChange={(event) => updateDraft("estimatedWorkHours", Math.max(0, Number(event.target.value) || 0))}
            onKeyDown={handleKeyDown}
            className={durationFieldClass}
            disabled={!canEdit || isSaving}
            aria-label="预计工时"
            title="单位：小时"
          />
          <Input
            type="number"
            min={0}
            step="0.5"
            value={draft.actualWorkHours}
            onBlur={commitDraft}
            onChange={(event) => updateDraft("actualWorkHours", Math.max(0, Number(event.target.value) || 0))}
            onKeyDown={handleKeyDown}
            className={durationFieldClass}
            disabled={!canEdit || isSaving}
            aria-label="实际工时"
            title="单位：小时"
          />
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
          <PredecessorSelect
            value={draft.predecessorTaskIds[0] ?? ""}
            onChange={(value) => {
              const nextDraft = { ...draft, predecessorTaskIds: value ? [value] : [] };
              setDraft(nextDraft);
              if (canEdit && !taskDraftEquals(row, nextDraft)) {
                void onUpdateTask?.(row, nextDraft);
              }
            }}
            options={predecessorOptions}
            currentTaskId={row.id}
            disabled={!canEdit || isSaving}
          />
        </>
      )}
    </div>
  );
};

const PredecessorSelect = ({
  currentTaskId,
  disabled,
  onChange,
  options,
  value,
}: {
  currentTaskId: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  options: ProjectGanttTask[];
  value: string;
}) => {
  const [showAllOptions, setShowAllOptions] = useState(false);
  const selectedOption = options.find((task) => task.id === value);
  const visibleOptions = showAllOptions
    ? options.filter((task) => task.id !== currentTaskId && task.taskName.trim())
    : selectedOption ? [selectedOption] : [];

  return (
    <Select
      value={value}
      aria-label="紧前任务"
      onOpenChange={setShowAllOptions}
      onChange={(event) => {
        onChange(event.target.value);
        setShowAllOptions(false);
      }}
      className={inlineSelectClass}
      disabled={disabled}
    >
      <option value="">无</option>
      {visibleOptions.map((task) => (
        <option key={task.id} value={task.id}>
          {task.taskCode} · {task.taskName || "未命名任务"}
        </option>
      ))}
    </Select>
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
