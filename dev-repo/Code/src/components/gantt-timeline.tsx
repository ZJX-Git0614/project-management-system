"use client";

import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, CornerDownRight, GripVertical, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ProjectGanttTask } from "@/domain/models";
import {
  addCalendarDays,
  buildGanttDependencyLinks,
  buildGanttRows,
  diffDays,
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
  reordering?: boolean;
  onCreateTask?: (parentTask?: ProjectGanttTask) => void;
  onUpdateTask?: (task: ProjectGanttTask, draft: GanttTaskDraft) => void | Promise<void>;
  onDeleteSelected?: (taskIds: string[]) => void | Promise<void>;
  onReorderTasks?: (taskIds: string[]) => void | Promise<void>;
}

export type GanttTaskDraft = {
  parentId?: string | null;
  taskCategory: string;
  taskName: string;
  startDate: string;
  durationDays: number;
  actualStartDate: string;
  actualEndDate: string;
  progress: number;
  predecessorTask: string;
};

const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 32;
const BAR_HEIGHT = 10;
const MIN_TIMELINE_WIDTH = 860;
const LEFT_WIDTH_EXPANDED = 1072;
const LEFT_WIDTH_COLLAPSED = 360;
const LEFT_COLUMNS_EXPANDED = "24px 112px 86px 180px 56px 94px 94px 94px 94px 76px 106px";
const LEFT_COLUMNS_COLLAPSED = "24px 112px 200px";
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

const getTaskDepth = (taskCode?: string) => (
  taskCode ? Math.max(0, taskCode.replace(/^Task/, "").split(".").length - 1) : 0
);

const taskGridColumns = (collapsed: boolean) => (
  collapsed ? LEFT_COLUMNS_COLLAPSED : LEFT_COLUMNS_EXPANDED
);

const leftPanelWidth = (collapsed: boolean) => (
  collapsed ? LEFT_WIDTH_COLLAPSED : LEFT_WIDTH_EXPANDED
);

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
  durationDays: task.durationDays,
  actualStartDate: task.actualStartDate ?? "",
  actualEndDate: task.actualEndDate ?? "",
  progress: Math.min(100, Math.max(0, task.progress ?? 0)),
  predecessorTask: task.predecessorTask,
});

const taskDraftEquals = (task: ProjectGanttTask, draft: GanttTaskDraft) => (
  task.taskCategory === draft.taskCategory
    && task.taskName === draft.taskName
    && task.startDate === draft.startDate
    && task.durationDays === draft.durationDays
    && (task.actualStartDate ?? "") === draft.actualStartDate
    && (task.actualEndDate ?? "") === draft.actualEndDate
    && (task.progress ?? 0) === draft.progress
    && task.predecessorTask === draft.predecessorTask
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
  reordering = false,
  onCreateTask,
  onUpdateTask,
  onDeleteSelected,
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
  const selectedCount = selectedTaskIds.length;

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
  const leftWidth = leftPanelWidth(detailsCollapsed);
  const bodyHeight = rows.length * ROW_HEIGHT;
  const todayOffset = diffDays(visibleStartDate, new Date().toISOString().slice(0, 10));
  const todayX = todayOffset >= 0 && todayOffset < visibleDays ? todayOffset * config.dayWidth : null;
  const rowById = new Map(
    rows.map((row, index) => [row.id, { row, index }])
  );
  const categoryCount = new Set(rows.map((row) => row.taskCategory)).size;
  const criticalCount = rows.filter((row) => row.isCritical).length;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
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
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:text-primary disabled:opacity-30"
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
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:text-primary disabled:opacity-30"
              aria-label="放大"
              title="放大"
            >
              <ZoomIn className="h-3 w-3" />
            </button>
          </div>
          {canCreate && (
            <Button
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
          {canDelete && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={toggleSelectionMode}
              disabled={deletingSelected}
            >
              {selectionMode ? "取消选择" : "选择"}
            </Button>
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

      <div className="overflow-auto">
        <div className="grid min-w-max" style={{ gridTemplateColumns: `${leftWidth}px ${timelineWidth}px` }}>
          <TaskGridHeader collapsed={detailsCollapsed} />
          <TimelineHeader
            config={config}
            visibleDays={visibleDays}
            visibleStartDate={visibleStartDate}
            width={timelineWidth}
          />

          <div className="sticky left-0 z-10 border-r border-border bg-card transition-colors duration-200 hover:border-primary/40">
            <button
              type="button"
              className={cn(
                "absolute -right-1 top-0 z-30 flex h-full w-1 cursor-pointer items-center justify-center transition-all duration-200",
                hoverCollapse ? "bg-primary/5" : "bg-transparent"
              )}
              onMouseEnter={() => setHoverCollapse(true)}
              onMouseLeave={() => setHoverCollapse(false)}
              onClick={() => setDetailsCollapsed((prev) => !prev)}
              title={detailsCollapsed ? "展开列" : "折叠列"}
              aria-label={detailsCollapsed ? "展开列" : "折叠列"}
            >
              <div className={cn(
                "flex h-8 items-center justify-center rounded-sm transition-all duration-200",
                hoverCollapse ? "opacity-100" : "opacity-0"
              )}>
                {detailsCollapsed ? <ChevronRight className="h-2.5 w-2.5 text-primary/70" /> : <ChevronLeft className="h-2.5 w-2.5 text-primary/70" />}
              </div>
            </button>
            <div
              className={cn(
                "relative h-3 border-b border-border/60",
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
            {rows.map((row, index) => (
                <EditableTaskRow
                  key={row.id}
                  canCreate={canCreate}
                  canEdit={canEdit}
                  creatingChild={creatingParentId === row.id}
                  dragged={draggedTaskId === row.id}
                  dropPosition={taskDropTarget?.id === row.id && draggedTaskId !== row.id ? taskDropTarget.position : null}
                  flashing={flashingTaskId === row.id}
                  index={index}
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
                    onCreateTask?.(row);
                  }}
                  onToggleSelected={() => toggleTaskSelection(row.id)}
                  onUpdateTask={onUpdateTask}
                  predecessorOptions={tasks.filter((task) => task.id !== row.id && task.taskName.trim())}
                  row={row}
                  selected={selectedTaskIds.includes(row.id)}
                  selectionLocked={isSelectedByAncestor(row.id)}
                  selectionMode={selectionMode}
                  collapsed={detailsCollapsed}
                />
            ))}
            <div
              className={cn(
                "relative h-3",
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

            {rows.map((row) => {
              const visualIndex = rowById.get(row.id)?.index ?? 0;
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
  emptyText,
  onCreateTask,
  setZoomIndex,
  setDetailsCollapsed,
}: {
  canCreate: boolean;
  creatingParentId: string | null;
  dayWidth: number;
  zoomIndex: number;
  detailsCollapsed: boolean;
  emptyText: string;
  onCreateTask?: (parentTask?: ProjectGanttTask) => void;
  setZoomIndex: (value: number | ((prev: number) => number)) => void;
  setDetailsCollapsed: (value: boolean | ((prev: boolean) => boolean)) => void;
}) => {
  const config = { dayWidth, tickEvery: getTickEvery(dayWidth) };
  const visibleStartDate = new Date().toISOString().slice(0, 10);
  const visibleDays = 28;
  const timelineWidth = Math.max(MIN_TIMELINE_WIDTH, visibleDays * config.dayWidth);
  const leftWidth = leftPanelWidth(detailsCollapsed);
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
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:text-primary disabled:opacity-30"
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
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:text-primary disabled:opacity-30"
              aria-label="放大"
              title="放大"
            >
              <ZoomIn className="h-3 w-3" />
            </button>
          </div>
          {canCreate && (
            <Button
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
          <TaskGridHeader collapsed={detailsCollapsed} />
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
                "absolute -right-1 top-0 z-30 flex h-full w-1 cursor-pointer items-center justify-center transition-all duration-200",
                hoverCollapse ? "bg-primary/5" : "bg-transparent"
              )}
              onMouseEnter={() => setHoverCollapse(true)}
              onMouseLeave={() => setHoverCollapse(false)}
              onClick={() => setDetailsCollapsed((prev) => !prev)}
              title={detailsCollapsed ? "展开列" : "折叠列"}
              aria-label={detailsCollapsed ? "展开列" : "折叠列"}
            >
              <div className={cn(
                "flex h-8 items-center justify-center rounded-sm transition-all duration-200",
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

const TaskGridHeader = ({ collapsed }: { collapsed: boolean }) => (
  <div
    className="sticky top-0 left-0 z-20 box-border grid items-center gap-1 border-b border-r border-border bg-muted px-2 text-[11px] font-medium text-foreground"
    style={{
      height: HEADER_HEIGHT,
      gridTemplateColumns: taskGridColumns(collapsed),
    }}
  >
    <span aria-hidden="true" />
    <span>任务ID</span>
    {!collapsed && <span>任务类别</span>}
    <span>任务名称</span>
    {!collapsed && (
      <>
        <span>工期</span>
        <span>计划开始</span>
        <span>计划完成</span>
        <span>实际开始</span>
        <span>实际完成</span>
        <span>当前进度</span>
        <span>紧前任务</span>
      </>
    )}
  </div>
);

const EditableTaskRow = ({
  canCreate,
  canEdit,
  creatingChild,
  dragged,
  dropPosition,
  flashing,
  index,
  isSaving,
  onDragEnd,
  onDragOver,
  onDragStart,
  onDrop,
  onStartChild,
  onToggleSelected,
  onUpdateTask,
  predecessorOptions,
  row,
  selected,
  selectionLocked,
  selectionMode,
  collapsed,
}: {
  canCreate: boolean;
  canEdit: boolean;
  collapsed: boolean;
  creatingChild: boolean;
  dragged: boolean;
  dropPosition: DropPosition | null;
  flashing: boolean;
  index: number;
  isSaving: boolean;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragStart: () => void;
  onDrop: () => void;
  onStartChild?: () => void;
  onToggleSelected: () => void;
  onUpdateTask?: (task: ProjectGanttTask, draft: GanttTaskDraft) => void | Promise<void>;
  predecessorOptions: ProjectGanttTask[];
  row: ReturnType<typeof buildGanttRows>[number];
  selected: boolean;
  selectionLocked: boolean;
  selectionMode: boolean;
}) => {
  const [draft, setDraft] = useState<GanttTaskDraft>(() => toTaskDraft(row));
  const taskDepth = getTaskDepth(row.taskCode);
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
        "group relative box-border grid cursor-default items-center gap-1 border-b border-border px-2 text-xs transition-[background,box-shadow,transform] duration-150",
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
      style={{ height: ROW_HEIGHT, gridTemplateColumns: taskGridColumns(collapsed) }}
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
      <div className="relative flex min-w-0 items-center gap-1.5 pr-1" style={{ paddingLeft: `${taskDepth * 10}px` }}>
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
        {isChildTask && <span className="h-px w-3 shrink-0 bg-primary/60" />}
        <span
          className="min-w-0 flex-1 truncate whitespace-nowrap pr-12 font-mono text-[11px] font-semibold text-muted-foreground"
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
              updateDraft("durationDays", digits ? Number(digits) : 1);
            }}
            onKeyDown={handleKeyDown}
            className={durationFieldClass}
            disabled={!canEdit || isSaving}
            aria-label="工期天数"
          />
          <Input
            type="date"
            value={draft.startDate}
            onBlur={commitDraft}
            onChange={(event) => updateDraft("startDate", event.target.value)}
            onKeyDown={handleKeyDown}
            className={inlineFieldClass}
            disabled={!canEdit || isSaving}
            aria-label="计划开始"
          />
          <span className="truncate px-2 text-muted-foreground">{row.endDate}</span>
          <Input
            type="date"
            value={draft.actualStartDate}
            onBlur={commitDraft}
            onChange={(event) => updateDraft("actualStartDate", event.target.value)}
            onKeyDown={handleKeyDown}
            className={inlineFieldClass}
            disabled={!canEdit || isSaving}
            aria-label="实际开始"
          />
          <Input
            type="date"
            value={draft.actualEndDate}
            onBlur={commitDraft}
            onChange={(event) => updateDraft("actualEndDate", event.target.value)}
            onKeyDown={handleKeyDown}
            className={inlineFieldClass}
            disabled={!canEdit || isSaving}
            aria-label="实际完成"
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
            value={draft.predecessorTask}
            onChange={(value) => {
              const nextDraft = { ...draft, predecessorTask: value };
              setDraft(nextDraft);
              if (canEdit && !taskDraftEquals(row, nextDraft)) {
                void onUpdateTask?.(row, nextDraft);
              }
            }}
            options={predecessorOptions}
            disabled={!canEdit || isSaving}
          />
        </>
      )}
    </div>
  );
};

const PredecessorSelect = ({
  disabled,
  onChange,
  options,
  value,
}: {
  disabled?: boolean;
  onChange: (value: string) => void;
  options: ProjectGanttTask[];
  value: string;
}) => (
  <Select
    value={value}
    onChange={(event) => onChange(event.target.value)}
    className={inlineSelectClass}
    disabled={disabled}
  >
    <option value="">无</option>
    {options.map((task) => (
      <option key={task.id} value={task.taskName}>
        {task.taskName}
      </option>
    ))}
  </Select>
);

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
