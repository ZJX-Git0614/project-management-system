"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProjectGanttTask } from "@/domain/models";
import { addCalendarDays, diffDays, getGanttDateRange, resolveGanttCriticalTaskIds } from "@/lib/gantt";
import type { GanttCalendarMode } from "@/lib/gantt-calendar";
import { formatGanttRelativeOffset, isGanttRelativeOffset } from "@/lib/gantt-relative-time";
import { cn } from "@/lib/utils";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const validDate = (value?: string | null) => Boolean(value && DATE_PATTERN.test(value));

const leafTasks = (tasks: ProjectGanttTask[]) => {
  const parentIds = new Set(tasks.map((task) => task.parentId).filter(Boolean));
  return tasks.filter((task) => !parentIds.has(task.id));
};

const taskOwnerLabels = (task: ProjectGanttTask) => {
  const labels = (task.ownerMembers ?? [])
    .map((member) => member.personName?.trim())
    .filter(Boolean) as string[];
  if (labels.length > 0) return [...new Set(labels)];
  if (task.ownerMember?.personName?.trim()) return [task.ownerMember.personName.trim()];
  return ["未分配"];
};

const relativeOffset = (task: ProjectGanttTask, key: "relativeStartOffsetDays" | "relativeFinishOffsetDays") => {
  const value = task[key];
  return isGanttRelativeOffset(value) ? value : null;
};

const compareTasks = (left: ProjectGanttTask, right: ProjectGanttTask) => {
  const leftOffset = relativeOffset(left, "relativeStartOffsetDays");
  const rightOffset = relativeOffset(right, "relativeStartOffsetDays");
  const relativeCompare = leftOffset === null && rightOffset === null
    ? 0
    : leftOffset === null
      ? 1
      : rightOffset === null
        ? -1
        : leftOffset - rightOffset;
  return relativeCompare
    || (left.startDate || "9999-12-31").localeCompare(right.startDate || "9999-12-31")
    || left.taskCode.localeCompare(right.taskCode, "zh-CN", { numeric: true })
    || left.id.localeCompare(right.id);
};

export const buildResourceSwimlanes = (tasks: ProjectGanttTask[]) => {
  const lanes = new Map<string, ProjectGanttTask[]>();
  leafTasks(tasks).forEach((task) => {
    taskOwnerLabels(task).forEach((owner) => lanes.set(owner, [...(lanes.get(owner) ?? []), task]));
  });
  return [...lanes.entries()]
    .map(([owner, laneTasks]) => ({ owner, tasks: laneTasks.sort(compareTasks) }))
    .sort((left, right) => {
      if (left.owner === "未分配") return 1;
      if (right.owner === "未分配") return -1;
      return left.owner.localeCompare(right.owner, "zh-CN");
    });
};

const taskExplanation = (task: ProjectGanttTask, criticalIds: Set<string>) => {
  const details = [
    `负责人：${taskOwnerLabels(task).join("、")}`,
    task.predecessorTaskIds?.length
      ? `FS 紧前任务：${task.predecessorTaskIds.length} 项`
      : "FS 紧前任务：无",
    task.totalFloatMinutes == null
      ? "总浮动：尚未计算"
      : `总浮动：${Math.round(Math.max(0, task.totalFloatMinutes) / 450 * 10) / 10} 天`,
    `父级边界：${task.parentBoundaryMode === "LOCKED" ? "锁定" : "自动汇总"}`,
  ];
  if (criticalIds.has(task.id)) details.push("关键路径：是");
  return details;
};

const TaskTooltip = ({ task, criticalIds, children }: {
  task: ProjectGanttTask;
  criticalIds: Set<string>;
  children: ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="top" align="start" className="z-[150] max-w-sm space-y-1 whitespace-normal leading-5">
      <div className="font-medium">{task.taskCode} · {task.taskName || "未命名任务"}</div>
      {taskExplanation(task, criticalIds).map((detail) => <div key={detail} className="text-muted-foreground">{detail}</div>)}
    </TooltipContent>
  </Tooltip>
);

export function ResourceSwimlaneView({ tasks, calendarMode }: {
  tasks: ProjectGanttTask[];
  calendarMode: GanttCalendarMode;
}) {
  const lanes = useMemo(() => buildResourceSwimlanes(tasks), [tasks]);
  const executableTasks = useMemo(() => leafTasks(tasks), [tasks]);
  const calendarRange = useMemo(() => getGanttDateRange(executableTasks), [executableTasks]);
  const relativeRange = useMemo(() => {
    const offsets = executableTasks.flatMap((task) => [
      relativeOffset(task, "relativeStartOffsetDays"),
      relativeOffset(task, "relativeFinishOffsetDays"),
    ]).filter((value): value is number => value !== null);
    if (offsets.length === 0) return null;
    const startOffset = Math.min(...offsets);
    const endOffset = Math.max(...offsets);
    return { startOffset, endOffset, totalDays: Math.max(1, endOffset - startOffset + 1) };
  }, [executableTasks]);
  const unscheduledRelativeRange = useMemo(() => {
    if (calendarRange || relativeRange || executableTasks.length === 0) return null;
    const totalDays = Math.max(
      1,
      ...executableTasks.map((task) => Math.max(1, Number(task.durationDays) || 0)),
    );
    return { startOffset: 0, endOffset: totalDays - 1, totalDays };
  }, [calendarRange, executableTasks, relativeRange]);
  const criticalIds = useMemo(() => resolveGanttCriticalTaskIds(tasks), [tasks]);

  if (lanes.length === 0) {
    return <div className="py-12 text-center text-sm text-muted-foreground">暂无可展示的负责人排期</div>;
  }

  const displayRelativeRange = relativeRange ?? unscheduledRelativeRange;
  const relativeSchedule = Boolean(displayRelativeRange && !calendarRange);
  const totalDays = relativeSchedule ? displayRelativeRange!.totalDays : Math.max(1, calendarRange!.totalDays);
  return (
    <TooltipProvider>
      <div className="min-h-0 overflow-auto border border-border/70">
        <div className="sticky top-0 z-10 grid min-w-[860px] grid-cols-[220px_170px_minmax(470px,1fr)] border-b border-border bg-muted/90 text-xs font-medium backdrop-blur">
          <div className="px-3 py-2">负责人 / 任务</div>
          <div className="px-3 py-2">计划区间</div>
          <div className="flex items-center justify-between px-3 py-2 text-muted-foreground">
            <span>{relativeSchedule ? formatGanttRelativeOffset(displayRelativeRange!.startOffset) : calendarRange!.startDate}</span>
            <span>{relativeSchedule ? (relativeRange ? "T0 相对工作日排期" : "待自动排期") : calendarMode === "WORKING_DAYS" ? "工作日排期" : "自然日排期"}</span>
            <span>{relativeSchedule ? formatGanttRelativeOffset(displayRelativeRange!.endOffset) : calendarRange!.endDate}</span>
          </div>
        </div>
        {lanes.map((lane) => (
          <section key={lane.owner} className="min-w-[860px] border-b border-border/70 last:border-b-0">
            <div className="grid grid-cols-[220px_170px_minmax(470px,1fr)] bg-muted/25 text-xs">
              <div className="px-3 py-2 font-semibold">{lane.owner}</div>
              <div className="px-3 py-2 text-muted-foreground">{lane.tasks.length} 项任务</div>
              <div className="px-3 py-2 text-muted-foreground">负责人泳道</div>
            </div>
            {lane.tasks.map((task) => {
              const hasCalendarDates = validDate(task.startDate) && validDate(task.finishDate);
              const relativeStart = relativeOffset(task, "relativeStartOffsetDays");
              const relativeFinish = relativeOffset(task, "relativeFinishOffsetDays");
              const hasRelativeDates = relativeStart !== null && relativeFinish !== null;
              const hasDates = relativeSchedule ? hasRelativeDates : hasCalendarDates;
              const offset = relativeSchedule
                ? hasRelativeDates ? Math.max(0, relativeStart - displayRelativeRange!.startOffset) : 0
                : hasCalendarDates ? Math.max(0, diffDays(calendarRange!.startDate, task.startDate)) : 0;
              const finishDate = task.finishDate || task.startDate;
              const span = relativeSchedule
                ? hasRelativeDates ? Math.max(1, relativeFinish - relativeStart + 1) : 0
                : hasCalendarDates ? Math.max(1, diffDays(task.startDate, finishDate) + 1) : 0;
              const left = Math.min(100, offset / totalDays * 100);
              const width = hasDates ? Math.max(0.8, Math.min(100 - left, span / totalDays * 100)) : 0;
              return (
                <TaskTooltip key={`${lane.owner}:${task.id}`} task={task} criticalIds={criticalIds}>
                  <div className="grid min-h-10 grid-cols-[220px_170px_minmax(470px,1fr)] border-t border-border/60 text-xs transition-colors hover:bg-muted/20">
                    <div className="min-w-0 px-3 py-2">
                      <div className="truncate font-medium" title={`${task.taskCode} · ${task.taskName}`}>{task.taskCode} · {task.taskName || "未命名任务"}</div>
                    </div>
                    <div className="px-3 py-2 text-muted-foreground">
                      {hasDates
                        ? relativeSchedule
                          ? `${formatGanttRelativeOffset(relativeStart)} 至 ${formatGanttRelativeOffset(relativeFinish)}`
                          : `${task.startDate} 至 ${task.finishDate}`
                        : "尚未排期"}
                    </div>
                    <div className="relative mx-3 my-2 h-5 bg-muted/30">
                      {hasDates && (
                        <div
                          className={cn(
                            "absolute top-0 h-full overflow-hidden border",
                            criticalIds.has(task.id)
                              ? "border-destructive/70 bg-destructive/20"
                              : "border-primary/55 bg-primary/18",
                          )}
                          style={{ left: `${left}%`, width: `${width}%` }}
                        >
                          <div className="h-full bg-primary/55" style={{ width: `${Math.max(0, Math.min(100, task.progress || 0))}%` }} />
                        </div>
                      )}
                    </div>
                  </div>
                </TaskTooltip>
              );
            })}
          </section>
        ))}
      </div>
    </TooltipProvider>
  );
}

const monthKeyFromDate = (date: string) => date.slice(0, 7);

const shiftMonth = (month: string, offset: number) => {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
};

const monthGridDates = (month: string) => {
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const start = addCalendarDays(`${year}-${String(monthNumber).padStart(2, "0")}-01`, -mondayOffset);
  return Array.from({ length: 42 }, (_, index) => addCalendarDays(start, index));
};

export const tasksForCalendarDate = (tasks: ProjectGanttTask[], date: string) => (
  leafTasks(tasks)
    .filter((task) => validDate(task.startDate) && validDate(task.finishDate) && task.startDate <= date && (task.finishDate || task.startDate) >= date)
    .sort(compareTasks)
);

export function ScheduleCalendarView({ tasks }: { tasks: ProjectGanttTask[] }) {
  const firstScheduledMonth = useMemo(() => {
    const firstDate = leafTasks(tasks).map((task) => task.startDate).filter(validDate).sort()[0];
    return firstDate ? monthKeyFromDate(firstDate) : new Date().toISOString().slice(0, 7);
  }, [tasks]);
  const [month, setMonth] = useState(firstScheduledMonth);
  const criticalIds = useMemo(() => resolveGanttCriticalTaskIds(tasks), [tasks]);
  const dates = useMemo(() => monthGridDates(month), [month]);

  useEffect(() => setMonth(firstScheduledMonth), [firstScheduledMonth]);

  return (
    <TooltipProvider>
      <div className="border border-border/70">
        <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
          <Button type="button" size="icon" variant="ghost" className="size-8" onClick={() => setMonth((value) => shiftMonth(value, -1))} aria-label="上个月">
            <ChevronLeft className="size-4" />
          </Button>
          <div className="text-sm font-semibold">{month.replace("-", " 年 ")} 月</div>
          <Button type="button" size="icon" variant="ghost" className="size-8" onClick={() => setMonth((value) => shiftMonth(value, 1))} aria-label="下个月">
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="grid grid-cols-7 border-b border-border bg-muted/75 text-center text-xs text-muted-foreground">
          {["一", "二", "三", "四", "五", "六", "日"].map((day) => <div key={day} className="py-2">周{day}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {dates.map((date) => {
            const occupiedTasks = tasksForCalendarDate(tasks, date);
            const inMonth = date.startsWith(month);
            return (
              <div key={date} className={cn("min-h-28 border-b border-r border-border/60 p-1.5 text-xs", !inMonth && "bg-muted/20 text-muted-foreground")}>
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-medium">{Number(date.slice(-2))}</span>
                  {occupiedTasks.length > 0 && <span className="text-[10px] text-muted-foreground">{occupiedTasks.length} 项</span>}
                </div>
                <div className="space-y-1">
                  {occupiedTasks.slice(0, 3).map((task) => (
                    <TaskTooltip key={task.id} task={task} criticalIds={criticalIds}>
                      <div className={cn(
                        "truncate border-l-2 bg-muted/35 px-1.5 py-1",
                        criticalIds.has(task.id) ? "border-l-destructive" : "border-l-primary",
                      )} title={`${task.taskCode} · ${task.taskName}`}>
                        <div className="truncate font-medium">{task.taskCode} · {task.taskName || "未命名任务"}</div>
                        <div className="truncate text-[10px] text-muted-foreground">{taskOwnerLabels(task).join("、")}</div>
                      </div>
                    </TaskTooltip>
                  ))}
                  {occupiedTasks.length > 3 && <div className="px-1 text-[10px] text-muted-foreground">另有 {occupiedTasks.length - 3} 项</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}
