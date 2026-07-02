"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

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
  newDraft?: GanttTaskDraft | null;
  newSubmitting?: boolean;
  savingTaskId?: string | null;
  deletingSelected?: boolean;
  reordering?: boolean;
  onStartCreate?: () => void;
  onCancelCreate?: () => void;
  onUpdateNewDraft?: <K extends keyof GanttTaskDraft>(key: K, value: GanttTaskDraft[K]) => void;
  onSubmitCreate?: () => void;
  onUpdateTask?: (task: ProjectGanttTask, draft: GanttTaskDraft) => void | Promise<void>;
  onDeleteSelected?: (taskIds: string[]) => void | Promise<void>;
  onReorderTasks?: (taskIds: string[]) => void | Promise<void>;
}

type ZoomMode = "day" | "week" | "month";
export type GanttTaskDraft = {
  taskCategory: string;
  taskName: string;
  startDate: string;
  durationDays: number;
  predecessorTask: string;
};

const ZOOM_CONFIG: Record<ZoomMode, { label: string; dayWidth: number; tickEvery: number }> = {
  day: { label: "日", dayWidth: 34, tickEvery: 1 },
  week: { label: "周", dayWidth: 14, tickEvery: 7 },
  month: { label: "月", dayWidth: 6, tickEvery: 10 },
};

const ROW_HEIGHT = 44;
const HEADER_HEIGHT = 72;
const LEFT_WIDTH = 920;
const BAR_HEIGHT = 18;
const taskGridColumns = (showProject: boolean) =>
  showProject
    ? "72px minmax(240px,1fr) 120px 70px 108px 108px 140px"
    : "72px minmax(260px,1fr) 120px 70px 108px 108px 140px";

const toTaskDraft = (task: ProjectGanttTask): GanttTaskDraft => ({
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
);

export const GanttTimeline = ({
  tasks,
  showProject = false,
  emptyText = "暂无甘特任务",
  canCreate = false,
  canEdit = false,
  canDelete = false,
  newDraft = null,
  newSubmitting = false,
  savingTaskId = null,
  deletingSelected = false,
  reordering = false,
  onStartCreate,
  onCancelCreate,
  onUpdateNewDraft,
  onSubmitCreate,
  onUpdateTask,
  onDeleteSelected,
  onReorderTasks,
}: GanttTimelineProps) => {
  const [zoom, setZoom] = useState<ZoomMode>("week");
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
        setZoom={setZoom}
        showProject={showProject}
        zoom={zoom}
        canCreate={canCreate}
        newDraft={newDraft}
        newSubmitting={newSubmitting}
        onCancelCreate={onCancelCreate}
        onStartCreate={onStartCreate}
        onSubmitCreate={onSubmitCreate}
        onUpdateNewDraft={onUpdateNewDraft}
      />
    );
  }

  const config = ZOOM_CONFIG[zoom];
  const visibleStartDate = addCalendarDays(range.startDate, -1);
  const visibleEndDate = addCalendarDays(range.endDate, 7);
  const visibleDays = diffDays(visibleStartDate, visibleEndDate) + 1;
  const timelineWidth = Math.max(760, visibleDays * config.dayWidth);
  const rowOffset = newDraft ? 1 : 0;
  const bodyHeight = (rows.length + rowOffset) * ROW_HEIGHT;
  const todayOffset = diffDays(visibleStartDate, new Date().toISOString().slice(0, 10));
  const todayX = todayOffset >= 0 && todayOffset < visibleDays ? todayOffset * config.dayWidth : null;
  const rowById = new Map(rows.map((row, index) => [row.id, { row, index: index + rowOffset }]));
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
          <div className="flex items-center overflow-hidden rounded-md border border-border">
            {(Object.keys(ZOOM_CONFIG) as ZoomMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={cn(
                  "h-7 px-3 text-xs transition-colors",
                  zoom === mode ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"
                )}
                onClick={() => setZoom(mode)}
              >
                {ZOOM_CONFIG[mode].label}
              </button>
            ))}
          </div>
          {canCreate && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={newDraft ? onCancelCreate : onStartCreate}
              disabled={newSubmitting}
            >
              {newDraft ? "取消新增" : "新增任务"}
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
        <div className="grid min-w-max" style={{ gridTemplateColumns: `${LEFT_WIDTH}px ${timelineWidth}px` }}>
          <TaskGridHeader showProject={showProject} />
          <TimelineHeader
            config={config}
            visibleDays={visibleDays}
            visibleStartDate={visibleStartDate}
            width={timelineWidth}
          />

          <div className="border-r border-border">
            {newDraft && onUpdateNewDraft && (
              <DraftTaskRow
                draft={newDraft}
                indexLabel="新"
                isSubmitting={newSubmitting}
                onSubmit={onSubmitCreate}
                onUpdate={onUpdateNewDraft}
                predecessorOptions={[]}
                showProject={showProject}
              />
            )}
            {rows.map((row, index) => (
              <EditableTaskRow
                key={row.id}
                canEdit={canEdit}
                dragged={draggedTaskId === row.id}
                index={index}
                isSaving={savingTaskId === row.id}
                onDragEnd={() => setDraggedTaskId(null)}
                onDragEnter={() => reorderTask(row.id)}
                onDragStart={() => setDraggedTaskId(row.id)}
                onToggleSelected={() => toggleTaskSelection(row.id)}
                onUpdateTask={onUpdateTask}
                predecessorOptions={tasks.filter((task) => task.id !== row.id)}
                row={row}
                selected={selectedTaskIds.includes(row.id)}
                selectionMode={selectionMode}
                showProject={showProject}
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

            {rows.map((row, index) => {
              const left = diffDays(visibleStartDate, row.startDate) * config.dayWidth;
              const width = Math.max(config.dayWidth * Math.max(1, row.durationDays), 16);
              const showBarLabel = width >= 72;
              return (
                <div
                  key={row.id}
                  className="absolute flex items-center"
                  style={{
                    left,
                    top: (index + rowOffset) * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2,
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
                    title={`${row.taskName}: ${row.startDate} ~ ${row.endDate}`}
                  />
                  {showBarLabel && (
                    <span className="pointer-events-none ml-2 max-w-[180px] truncate text-[11px] text-muted-foreground">
                      {row.taskName}
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
  emptyText,
  newDraft,
  newSubmitting,
  onCancelCreate,
  onStartCreate,
  onSubmitCreate,
  onUpdateNewDraft,
  setZoom,
  showProject,
  zoom,
}: {
  canCreate: boolean;
  emptyText: string;
  newDraft: GanttTaskDraft | null;
  newSubmitting: boolean;
  onCancelCreate?: () => void;
  onStartCreate?: () => void;
  onSubmitCreate?: () => void;
  onUpdateNewDraft?: <K extends keyof GanttTaskDraft>(key: K, value: GanttTaskDraft[K]) => void;
  setZoom: (zoom: ZoomMode) => void;
  showProject: boolean;
  zoom: ZoomMode;
}) => {
  const config = ZOOM_CONFIG[zoom];
  const visibleStartDate = new Date().toISOString().slice(0, 10);
  const visibleDays = 28;
  const timelineWidth = Math.max(760, visibleDays * config.dayWidth);
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
          <div className="flex items-center overflow-hidden rounded-md border border-border">
            {(Object.keys(ZOOM_CONFIG) as ZoomMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={cn(
                  "h-7 px-3 text-xs transition-colors",
                  zoom === mode ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"
                )}
                onClick={() => setZoom(mode)}
              >
                {ZOOM_CONFIG[mode].label}
              </button>
            ))}
          </div>
          {canCreate && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={newDraft ? onCancelCreate : onStartCreate}
              disabled={newSubmitting}
            >
              {newDraft ? "取消新增" : "新增任务"}
            </Button>
          )}
        </div>
      </div>

      <div className="overflow-auto">
        <div className="grid min-w-max" style={{ gridTemplateColumns: `${LEFT_WIDTH}px ${timelineWidth}px` }}>
          <TaskGridHeader showProject={showProject} />
          <TimelineHeader
            config={config}
            visibleDays={visibleDays}
            visibleStartDate={visibleStartDate}
            width={timelineWidth}
          />

          <div className="border-r border-border bg-background" style={{ height: bodyHeight }}>
            {newDraft && onUpdateNewDraft ? (
              <DraftTaskRow
                draft={newDraft}
                indexLabel="新"
                isSubmitting={newSubmitting}
                onSubmit={onSubmitCreate}
                onUpdate={onUpdateNewDraft}
                predecessorOptions={[]}
                showProject={showProject}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {emptyText}
              </div>
            )}
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

const TaskGridHeader = ({ showProject }: { showProject: boolean }) => (
  <div
    className="sticky top-0 z-10 grid items-center border-b border-r border-border bg-muted px-3 text-xs font-medium text-foreground"
    style={{
      height: HEADER_HEIGHT,
      gridTemplateColumns: taskGridColumns(showProject),
    }}
  >
    <span>任务ID</span>
    <span>任务名称</span>
    <span>类别</span>
    <span>工期</span>
    <span>开始</span>
    <span>完成</span>
    <span>紧前任务</span>
  </div>
);

const EditableTaskRow = ({
  canEdit,
  dragged,
  index,
  isSaving,
  onDragEnd,
  onDragEnter,
  onDragStart,
  onToggleSelected,
  onUpdateTask,
  predecessorOptions,
  row,
  selected,
  selectionMode,
  showProject,
}: {
  canEdit: boolean;
  dragged: boolean;
  index: number;
  isSaving: boolean;
  onDragEnd: () => void;
  onDragEnter: () => void;
  onDragStart: () => void;
  onToggleSelected: () => void;
  onUpdateTask?: (task: ProjectGanttTask, draft: GanttTaskDraft) => void | Promise<void>;
  predecessorOptions: ProjectGanttTask[];
  row: ReturnType<typeof buildGanttRows>[number];
  selected: boolean;
  selectionMode: boolean;
  showProject: boolean;
}) => {
  const [draft, setDraft] = useState<GanttTaskDraft>(() => toTaskDraft(row));

  const updateDraft = <K extends keyof GanttTaskDraft>(key: K, value: GanttTaskDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
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
        "grid cursor-grab items-center border-b border-border px-3 text-xs active:cursor-grabbing",
        row.isCritical ? "bg-destructive/5" : index % 2 === 0 ? "bg-background" : "bg-muted/10",
        selected && "bg-primary/15",
        dragged && "opacity-50"
      )}
      draggable={canEdit}
      onDragEnd={onDragEnd}
      onDragEnter={onDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragStart={onDragStart}
      style={{ height: ROW_HEIGHT, gridTemplateColumns: taskGridColumns(showProject) }}
    >
      <div className="flex min-w-0 items-center gap-2">
        {selectionMode && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            className="h-3.5 w-3.5 rounded border-border bg-background"
            onClick={(event) => event.stopPropagation()}
          />
        )}
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={row.id}>
          {row.id.slice(-6)}
        </span>
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1">
          <Input
            value={draft.taskName}
            onBlur={commitDraft}
            onChange={(event) => updateDraft("taskName", event.target.value)}
            onKeyDown={handleKeyDown}
            className="h-7 text-xs font-medium"
            disabled={!canEdit || isSaving}
          />
          {row.isCritical && (
            <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">
              关键
            </span>
          )}
        </div>
        {showProject && row.project && (
          <div className="truncate text-[11px] text-muted-foreground">
            {row.project.name}{row.project.code ? ` · ${row.project.code}` : ""}
          </div>
        )}
      </div>
      <Input
        value={draft.taskCategory}
        onBlur={commitDraft}
        onChange={(event) => updateDraft("taskCategory", event.target.value)}
        onKeyDown={handleKeyDown}
        className="h-7 text-xs"
        disabled={!canEdit || isSaving}
      />
      <Input
        type="number"
        min={1}
        value={draft.durationDays}
        onBlur={commitDraft}
        onChange={(event) => updateDraft("durationDays", Number(event.target.value) || 1)}
        onKeyDown={handleKeyDown}
        className="h-7 text-xs"
        disabled={!canEdit || isSaving}
      />
      <Input
        type="date"
        value={draft.startDate}
        onBlur={commitDraft}
        onChange={(event) => updateDraft("startDate", event.target.value)}
        onKeyDown={handleKeyDown}
        className="h-7 text-xs"
        disabled={!canEdit || isSaving}
      />
      <span className="text-muted-foreground">{row.endDate}</span>
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
    </div>
  );
};

const DraftTaskRow = ({
  draft,
  indexLabel,
  isSubmitting,
  onSubmit,
  onUpdate,
  predecessorOptions,
  showProject,
}: {
  draft: GanttTaskDraft;
  indexLabel: string;
  isSubmitting: boolean;
  onSubmit?: () => void;
  onUpdate: <K extends keyof GanttTaskDraft>(key: K, value: GanttTaskDraft[K]) => void;
  predecessorOptions: ProjectGanttTask[];
  showProject: boolean;
}) => (
  <div
    className="grid items-center border-b border-border bg-muted/30 px-3 text-xs"
    style={{ height: ROW_HEIGHT, gridTemplateColumns: taskGridColumns(showProject) }}
  >
    <span className="text-muted-foreground">{indexLabel}</span>
    <Input
      value={draft.taskName}
      onChange={(event) => onUpdate("taskName", event.target.value)}
      className="h-7 text-xs"
      placeholder="任务名称"
      autoFocus={indexLabel === "新"}
    />
    <Input
      value={draft.taskCategory}
      onChange={(event) => onUpdate("taskCategory", event.target.value)}
      className="h-7 text-xs"
      placeholder="任务类别"
    />
    <Input
      type="number"
      min={1}
      value={draft.durationDays}
      onChange={(event) => onUpdate("durationDays", Number(event.target.value) || 1)}
      className="h-7 text-xs"
    />
    <Input
      type="date"
      value={draft.startDate}
      onChange={(event) => onUpdate("startDate", event.target.value)}
      className="h-7 text-xs"
    />
    <span className="text-xs text-muted-foreground">保存后计算</span>
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      <PredecessorSelect
        value={draft.predecessorTask}
        onChange={(value) => onUpdate("predecessorTask", value)}
        options={predecessorOptions}
        disabled={predecessorOptions.length === 0}
      />
      <Button size="sm" className="h-7 text-xs" onClick={onSubmit} disabled={isSubmitting}>
        {isSubmitting ? "保存中..." : "保存"}
      </Button>
    </div>
  </div>
);

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
    className="h-7 text-xs"
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
