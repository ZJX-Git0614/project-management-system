"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Plus } from "lucide-react";

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
  predecessorTask: string;
};

const ROW_HEIGHT = 38;
const HEADER_HEIGHT = 58;
const BAR_HEIGHT = 14;
const MIN_TIMELINE_WIDTH = 860;
const LEFT_WIDTH_EXPANDED = 940;
const LEFT_WIDTH_COLLAPSED = 420;
const LEFT_COLUMNS_EXPANDED = "152px 240px 116px 58px 102px 102px 122px";
const LEFT_COLUMNS_COLLAPSED = "152px 260px";
const MIN_ZOOM = 6;
const MAX_ZOOM = 46;
const DEFAULT_ZOOM = 18;

const getTickEvery = (dayWidth: number) => {
  if (dayWidth >= 30) return 1;
  if (dayWidth >= 14) return 7;
  return 14;
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
  "h-7 w-full min-w-0 rounded px-2 text-xs shadow-none transition-colors",
  "!border-transparent !bg-transparent !ring-0 !ring-offset-0",
  "hover:!border-border/50 group-hover:!bg-muted/10",
  "focus:!border-primary/50 focus:!bg-background focus:!ring-1 focus:!ring-primary/20",
  "disabled:cursor-default disabled:opacity-100"
);

const inlineSelectClass = cn(
  "h-7 w-full min-w-0 rounded px-2 text-xs shadow-none transition-colors",
  "!border-transparent !bg-transparent !ring-0 !ring-offset-0",
  "hover:!border-border/50 group-hover:!bg-muted/10",
  "focus:!border-primary/50 focus:!bg-background focus:!ring-1 focus:!ring-primary/20",
  "disabled:cursor-default disabled:opacity-100"
);

const toTaskDraft = (task: ProjectGanttTask): GanttTaskDraft => ({
  parentId: task.parentId ?? null,
  taskCategory: task.taskCategory,
  taskName: task.taskName,
  startDate: task.startDate,
  durationDays: task.durationDays,
  predecessorTask: task.predecessorTask,
});

const taskDraftEquals = (task: ProjectGanttTask, draft: GanttTaskDraft) => (
  task.taskCategory === draft.taskCategory
    && task.taskName === draft.taskName
    && task.startDate === draft.startDate
    && task.durationDays === draft.durationDays
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
  const [dayWidth, setDayWidth] = useState(DEFAULT_ZOOM);
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const range = getGanttDateRange(tasks);
  const rows = useMemo(() => buildGanttRows(tasks), [tasks]);
  const dependencyLinks = useMemo(() => buildGanttDependencyLinks(tasks), [tasks]);
  const selectedCount = selectedTaskIds.length;

  const toggleSelectionMode = () => {
    setSelectionMode((prev) => !prev);
    setSelectedTaskIds([]);
  };

  const toggleTaskSelection = (taskId: string) => {
    setSelectedTaskIds((prev) => (
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]
    ));
  };

  const deleteSelectedTasks = () => {
    if (selectedTaskIds.length === 0) return;
    void Promise.resolve(onDeleteSelected?.(selectedTaskIds)).then(() => {
      setSelectedTaskIds([]);
      setSelectionMode(false);
    });
  };

  const reorderTask = (targetTaskId: string) => {
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
    nextTaskIds.splice(toIndex, 0, movedTaskId);
    void onReorderTasks?.(nextTaskIds);
  };

  if (!range || rows.length === 0) {
    return (
      <EmptyGanttTimeline
        emptyText={emptyText}
        dayWidth={dayWidth}
        detailsCollapsed={detailsCollapsed}
        setDayWidth={setDayWidth}
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
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/20 px-3 py-2">
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
            <span className="inline-block h-2.5 w-5 rounded-full bg-destructive" />
            关键路径 {criticalCount}
          </div>
          {reordering && <span className="text-muted-foreground">排序保存中...</span>}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => setDetailsCollapsed((prev) => !prev)}
          >
            {detailsCollapsed ? "展开列" : "折叠列"}
          </Button>
          <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1">
            <span className="text-muted-foreground">缩放</span>
            <input
              aria-label="甘特图缩放"
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={2}
              value={dayWidth}
              onChange={(event) => setDayWidth(Number(event.target.value))}
              className="h-4 w-28 accent-primary"
            />
            <span className="w-9 text-right text-muted-foreground">{dayWidth}px</span>
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

          <div className="border-r border-border">
            {rows.map((row, index) => (
                <EditableTaskRow
                  key={row.id}
                  canCreate={canCreate}
                  canEdit={canEdit}
                  creatingChild={creatingParentId === row.id}
                  dragged={draggedTaskId === row.id}
                  index={index}
                  isSaving={savingTaskId === row.id}
                  onDragEnd={() => setDraggedTaskId(null)}
                  onDragEnter={() => reorderTask(row.id)}
                  onDragStart={() => setDraggedTaskId(row.id)}
                  onStartChild={() => {
                    setDetailsCollapsed(false);
                    onCreateTask?.(row);
                  }}
                  onToggleSelected={() => toggleTaskSelection(row.id)}
                  onUpdateTask={onUpdateTask}
                  predecessorOptions={tasks.filter((task) => task.id !== row.id && task.taskName.trim())}
                  row={row}
                  selected={selectedTaskIds.includes(row.id)}
                  selectionMode={selectionMode}
                  collapsed={detailsCollapsed}
                />
            ))}
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
              const width = Math.max(config.dayWidth * Math.max(1, row.durationDays), 16);
              const showBarLabel = width >= 72;
              const barLabel = row.taskName || row.taskCode;
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
                      "h-full w-full rounded-sm border shadow-sm",
                      row.isCritical
                        ? "border-destructive/60 bg-destructive"
                        : "border-primary/60 bg-primary"
                    )}
                    title={`${barLabel}: ${row.startDate} ~ ${row.endDate}`}
                  />
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
  detailsCollapsed,
  emptyText,
  onCreateTask,
  setDayWidth,
  setDetailsCollapsed,
}: {
  canCreate: boolean;
  creatingParentId: string | null;
  dayWidth: number;
  detailsCollapsed: boolean;
  emptyText: string;
  onCreateTask?: (parentTask?: ProjectGanttTask) => void;
  setDayWidth: (value: number) => void;
  setDetailsCollapsed: (value: boolean | ((prev: boolean) => boolean)) => void;
}) => {
  const config = { dayWidth, tickEvery: getTickEvery(dayWidth) };
  const visibleStartDate = new Date().toISOString().slice(0, 10);
  const visibleDays = 28;
  const timelineWidth = Math.max(MIN_TIMELINE_WIDTH, visibleDays * config.dayWidth);
  const leftWidth = leftPanelWidth(detailsCollapsed);
  const bodyHeight = ROW_HEIGHT * 3;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/20 px-3 py-2">
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
            <span className="inline-block h-2.5 w-5 rounded-full bg-destructive" />
            关键路径 0
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => setDetailsCollapsed((prev) => !prev)}
          >
            {detailsCollapsed ? "展开列" : "折叠列"}
          </Button>
          <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1">
            <span className="text-muted-foreground">缩放</span>
            <input
              aria-label="甘特图缩放"
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={2}
              value={dayWidth}
              onChange={(event) => setDayWidth(Number(event.target.value))}
              className="h-4 w-28 accent-primary"
            />
            <span className="w-9 text-right text-muted-foreground">{dayWidth}px</span>
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

          <div className="flex items-center justify-center border-r border-border bg-background text-xs text-muted-foreground" style={{ height: bodyHeight }}>
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
    className="sticky top-0 z-10 grid items-center gap-2 border-b border-r border-border bg-muted px-3 text-xs font-medium text-foreground"
    style={{
      height: HEADER_HEIGHT,
      gridTemplateColumns: taskGridColumns(collapsed),
    }}
  >
    <span>任务ID</span>
    <span>任务名称</span>
    {!collapsed && (
      <>
        <span>类别</span>
        <span>工期</span>
        <span>开始</span>
        <span>完成</span>
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
  index,
  isSaving,
  onDragEnd,
  onDragEnter,
  onDragStart,
  onStartChild,
  onToggleSelected,
  onUpdateTask,
  predecessorOptions,
  row,
  selected,
  selectionMode,
  collapsed,
}: {
  canCreate: boolean;
  canEdit: boolean;
  collapsed: boolean;
  creatingChild: boolean;
  dragged: boolean;
  index: number;
  isSaving: boolean;
  onDragEnd: () => void;
  onDragEnter: () => void;
  onDragStart: () => void;
  onStartChild?: () => void;
  onToggleSelected: () => void;
  onUpdateTask?: (task: ProjectGanttTask, draft: GanttTaskDraft) => void | Promise<void>;
  predecessorOptions: ProjectGanttTask[];
  row: ReturnType<typeof buildGanttRows>[number];
  selected: boolean;
  selectionMode: boolean;
}) => {
  const [draft, setDraft] = useState<GanttTaskDraft>(() => toTaskDraft(row));
  const taskNameDisplay = row.isCritical ? `${draft.taskName}【关键路径】` : draft.taskName;
  const taskDepth = getTaskDepth(row.taskCode);
  const isChildTask = taskDepth > 0;

  const updateDraft = <K extends keyof GanttTaskDraft>(key: K, value: GanttTaskDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const updateTaskName = (value: string) => {
    updateDraft("taskName", value.replace(/【关键路径】/g, ""));
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
        "group grid cursor-grab items-center gap-2 border-b border-border px-3 text-xs active:cursor-grabbing",
        isChildTask ? "bg-primary/5" : index % 2 === 0 ? "bg-background" : "bg-muted/25",
        row.isCritical
          ? "shadow-[inset_3px_0_0_hsl(var(--destructive))]"
          : isChildTask && "shadow-[inset_3px_0_0_hsl(var(--primary))]",
        selected && "bg-primary/15",
        dragged && "opacity-50",
        "hover:bg-primary/10"
      )}
      draggable={canEdit}
      onDragEnd={onDragEnd}
      onDragEnter={onDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragStart={onDragStart}
      style={{ height: ROW_HEIGHT, gridTemplateColumns: taskGridColumns(collapsed) }}
    >
      <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: `${taskDepth * 10}px` }}>
        {selectionMode && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            className="h-3.5 w-3.5 rounded border-border bg-background"
            onClick={(event) => event.stopPropagation()}
          />
        )}
        {isChildTask && <span className="h-px w-3 shrink-0 bg-primary/60" />}
        <span
          className="shrink-0 whitespace-nowrap font-mono text-[11px] font-semibold text-muted-foreground"
          title={row.taskCode || row.id}
        >
          {row.taskCode || `Task${index + 1}`}
        </span>
        {canCreate && (
          <button
            type="button"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-background text-muted-foreground opacity-0 transition hover:border-primary/50 hover:text-primary group-hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onStartChild?.();
            }}
            disabled={creatingChild}
            title={creatingChild ? "创建中..." : "新增子任务"}
            aria-label={creatingChild ? "创建中..." : "新增子任务"}
          >
            <Plus className="h-3 w-3" />
          </button>
        )}
      </div>
      <Input
        value={taskNameDisplay}
        onBlur={commitDraft}
        onChange={(event) => updateTaskName(event.target.value)}
        onKeyDown={handleKeyDown}
        className={cn(inlineFieldClass, "font-medium", row.isCritical && "text-destructive")}
        disabled={!canEdit || isSaving}
        style={{ paddingLeft: `${8 + taskDepth * 18}px` }}
        placeholder="任务名称"
        title={taskNameDisplay}
      />
      {!collapsed && (
        <>
          <Input
            value={draft.taskCategory}
            onBlur={commitDraft}
            onChange={(event) => updateDraft("taskCategory", event.target.value)}
            onKeyDown={handleKeyDown}
            className={inlineFieldClass}
            disabled={!canEdit || isSaving}
            placeholder="任务类别"
          />
          <Input
            type="number"
            min={1}
            value={draft.durationDays}
            onBlur={commitDraft}
            onChange={(event) => updateDraft("durationDays", Number(event.target.value) || 1)}
            onKeyDown={handleKeyDown}
            className={inlineFieldClass}
            disabled={!canEdit || isSaving}
          />
          <Input
            type="date"
            value={draft.startDate}
            onBlur={commitDraft}
            onChange={(event) => updateDraft("startDate", event.target.value)}
            onKeyDown={handleKeyDown}
            className={inlineFieldClass}
            disabled={!canEdit || isSaving}
          />
          <span className="truncate px-2 text-muted-foreground">{row.endDate}</span>
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
  const months = buildMonthBands(visibleStartDate, visibleDays, config.dayWidth);
  const ticks = Array.from({ length: visibleDays }, (_, index) => ({
    date: addCalendarDays(visibleStartDate, index),
    x: index * config.dayWidth,
  })).filter((_, index) => index % config.tickEvery === 0);

  return (
    <div className="sticky top-0 z-10 border-b border-border bg-muted" style={{ width, height: HEADER_HEIGHT }}>
      <svg height={HEADER_HEIGHT} width={width} aria-hidden="true">
        {months.map((month) => (
          <g key={`${month.label}-${month.x}`}>
            <rect x={month.x} y={0} width={month.width} height={32} className="fill-muted" />
            <text x={month.x + 8} y={21} className="fill-foreground" fontSize={12} fontWeight={600}>
              {month.label}
            </text>
          </g>
        ))}
        {ticks.map((tick) => {
          const date = parseGanttDate(tick.date);
          const isWeekend = [0, 6].includes(date.getUTCDay());
          return (
            <g key={tick.date}>
              <line x1={tick.x} x2={tick.x} y1={32} y2={HEADER_HEIGHT} className="stroke-border" />
              <text
                x={tick.x + 5}
                y={56}
                className={isWeekend ? "fill-muted-foreground" : "fill-foreground"}
                fontSize={11}
              >
                {tick.date.slice(5)}
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

const buildMonthBands = (startDate: string, visibleDays: number, dayWidth: number) => {
  const bands: Array<{ label: string; x: number; width: number }> = [];
  let currentLabel = "";
  let startIndex = 0;

  for (let index = 0; index < visibleDays; index += 1) {
    const date = parseGanttDate(addCalendarDays(startDate, index));
    const label = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!currentLabel) currentLabel = label;
    if (label !== currentLabel) {
      bands.push({ label: currentLabel, x: startIndex * dayWidth, width: (index - startIndex) * dayWidth });
      currentLabel = label;
      startIndex = index;
    }
  }

  bands.push({
    label: currentLabel,
    x: startIndex * dayWidth,
    width: Math.max(1, (visibleDays - startIndex) * dayWidth),
  });

  return bands;
};
