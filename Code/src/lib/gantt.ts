import type { ProjectGanttTask } from "@/domain/models";
import type { GanttCalendarMode } from "@/lib/gantt-calendar";
import {
  formatGanttRelativeOffset,
  isGanttRelativeOffset,
  normalizeGanttRelativeOffset,
} from "@/lib/gantt-relative-time";
import { calculateResourceAwareGanttCpm } from "@/lib/gantt-resource-cpm";
import { buildGanttLeafScheduleNetwork } from "@/lib/gantt-schedule-network";

export interface GanttDateRange {
  startDate: string;
  endDate: string;
  totalDays: number;
}

export type GanttCoordinateMode = "AUTO" | "ABSOLUTE" | "RELATIVE";

export interface GanttDisplayOptions {
  coordinateMode?: GanttCoordinateMode;
  calendarMode?: GanttCalendarMode;
}

export interface GanttRow extends ProjectGanttTask {
  endDate: string;
  spanDays: number;
  offsetDays: number;
  timelineStartDays: number;
  timelineEndDays: number;
  startDisplayLabel: string;
  finishDisplayLabel: string;
  leftPercent: number;
  widthPercent: number;
  isCritical: boolean;
}

export interface GanttDependencyLink {
  predecessorId: string;
  successorId: string;
  predecessorName: string;
  successorName: string;
}

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const parseGanttDate = (value: string): Date => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

export const formatGanttDate = (value: Date): string => value.toISOString().slice(0, 10);

export const diffDaysInclusive = (startDate: string, endDate: string): number => {
  const start = parseGanttDate(startDate).getTime();
  const end = parseGanttDate(endDate).getTime();
  return Math.max(1, Math.round((end - start) / MS_PER_DAY) + 1);
};

export const diffDays = (startDate: string, endDate: string): number => {
  const start = parseGanttDate(startDate).getTime();
  const end = parseGanttDate(endDate).getTime();
  return Math.round((end - start) / MS_PER_DAY);
};

export const addDaysInclusive = (startDate: string, durationDays: number): string => {
  if (!startDate || !Number.isFinite(durationDays) || durationDays <= 0) return "";
  const start = parseGanttDate(startDate);
  const end = new Date(start.getTime() + (Math.ceil(durationDays) - 1) * MS_PER_DAY);
  return formatGanttDate(end);
};

export const addCalendarDays = (startDate: string, days: number): string => {
  const start = parseGanttDate(startDate);
  return formatGanttDate(new Date(start.getTime() + days * MS_PER_DAY));
};

const GANTT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const resolveGanttTaskEndDate = (task: ProjectGanttTask) => {
  if (!GANTT_DATE_PATTERN.test(task.startDate)) return "";
  if (GANTT_DATE_PATTERN.test(task.finishDate ?? "") && task.finishDate! >= task.startDate) {
    return task.finishDate!;
  }
  return addDaysInclusive(task.startDate, task.durationDays) || task.startDate;
};

const ganttTaskCalendarSpanDays = (task: ProjectGanttTask, endDate: string) => {
  if (!GANTT_DATE_PATTERN.test(task.startDate) || !endDate) return 0;
  if (!GANTT_DATE_PATTERN.test(task.finishDate ?? "") && !(task.durationDays > 0)) return 0;
  return diffDaysInclusive(task.startDate, endDate);
};

const resolveGanttCoordinateMode = (
  tasks: ProjectGanttTask[],
  requestedMode: GanttCoordinateMode = "AUTO",
): Exclude<GanttCoordinateMode, "AUTO"> => {
  if (requestedMode !== "AUTO") return requestedMode;
  return tasks.some((task) => (
    isGanttRelativeOffset(task.relativeStartOffsetDays)
    || isGanttRelativeOffset(task.relativeFinishOffsetDays)
  )) ? "RELATIVE" : "ABSOLUTE";
};

export const getGanttDateRange = (
  tasks: ProjectGanttTask[],
  options: GanttDisplayOptions = {},
): GanttDateRange | null => {
  if (tasks.length === 0) return null;

  // A schedule with unresolved T0 offsets is intentionally calendar-free.
  // Older imports can retain absolute dates alongside relative coordinates;
  // relative coordinates are authoritative until a project T0 is materialized.
  if (resolveGanttCoordinateMode(tasks, options.coordinateMode) === "RELATIVE") return null;

  const datePairs = tasks
    .filter((task) => GANTT_DATE_PATTERN.test(task.startDate))
    .map((task) => ({
      startDate: task.startDate,
      endDate: resolveGanttTaskEndDate(task),
    }));
  if (datePairs.length === 0) return null;
  const startDate = datePairs.map((item) => item.startDate).sort()[0];
  const endDate = datePairs.map((item) => item.endDate).sort().at(-1) ?? startDate;

  return {
    startDate,
    endDate,
    totalDays: diffDaysInclusive(startDate, endDate),
  };
};

export const buildGanttDependencyLinks = (tasks: ProjectGanttTask[]): GanttDependencyLink[] => {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const taskByName = new Map<string, ProjectGanttTask>();
  for (const task of tasks) {
    if (!taskByName.has(task.taskName)) taskByName.set(task.taskName, task);
  }

  return tasks.flatMap((task) => {
    if (task.predecessorTaskIds && task.predecessorTaskIds.length > 0) {
      return task.predecessorTaskIds.flatMap((predecessorId) => {
        const predecessor = taskById.get(predecessorId);
        if (!predecessor || predecessor.id === task.id) return [];
        return [{
          predecessorId: predecessor.id,
          successorId: task.id,
          predecessorName: predecessor.taskName,
          successorName: task.taskName,
        }];
      });
    }
    const predecessorNames = parsePredecessorNames(task.predecessorTask);
    return predecessorNames.flatMap((predecessorName) => {
      const predecessor = taskByName.get(predecessorName);
      if (!predecessor || predecessor.id === task.id) return [];
      return [{
        predecessorId: predecessor.id,
        successorId: task.id,
        predecessorName: predecessor.taskName,
        successorName: task.taskName,
      }];
    });
  });
};

export const findGanttCriticalTaskIds = (tasks: ProjectGanttTask[]): Set<string> => {
  if (tasks.length === 0) return new Set();
  // Summary rows roll up child dates but do not represent executable work.
  // Critical-path visibility is intentionally limited to terminal WBS nodes.
  const parentTaskIds = new Set(tasks.flatMap((task) => task.parentId ? [task.parentId] : []));
  const leafTaskIds = new Set(tasks.filter((task) => !parentTaskIds.has(task.id)).map((task) => task.id));
  const leafTasks = tasks.filter((task) => leafTaskIds.has(task.id));
  const activeLeafTasks = leafTasks.filter((task) => Number(task.progress ?? 0) < 100);
  const activeLeafTaskIds = new Set(activeLeafTasks.map((task) => task.id));
  if (activeLeafTaskIds.size === 0) return new Set();

  const fallbackDependenciesBySuccessorId = new Map<string, Array<{
    predecessorTaskId: string;
    type: number;
    lag: number;
    lagFormat: number;
  }>>();
  buildGanttDependencyLinks(tasks).forEach((link) => {
    fallbackDependenciesBySuccessorId.set(link.successorId, [
      ...(fallbackDependenciesBySuccessorId.get(link.successorId) ?? []),
      { predecessorTaskId: link.predecessorId, type: 1, lag: 0, lagFormat: 7 },
    ]);
  });
  const expandedNetwork = buildGanttLeafScheduleNetwork(tasks.map((task) => ({
    id: task.id,
    projectId: task.projectId,
    parentId: task.parentId,
    predecessorDependencies: (task.predecessorDependencies?.length ?? 0) > 0
      ? task.predecessorDependencies
      : fallbackDependenciesBySuccessorId.get(task.id) ?? [],
  })));
  const links = expandedNetwork.dependencies.filter((dependency) => (
    activeLeafTaskIds.has(dependency.predecessorTaskId)
    && activeLeafTaskIds.has(dependency.successorTaskId)
  ));
  const durationById = new Map(activeLeafTasks.map((task) => [task.id, Math.max(0, task.durationDays)]));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const inDegree = new Map(activeLeafTasks.map((task) => [task.id, 0]));

  for (const link of links) {
    outgoing.set(link.predecessorTaskId, [
      ...(outgoing.get(link.predecessorTaskId) ?? []),
      link.successorTaskId,
    ]);
    incoming.set(link.successorTaskId, [
      ...(incoming.get(link.successorTaskId) ?? []),
      link.predecessorTaskId,
    ]);
    inDegree.set(link.successorTaskId, (inDegree.get(link.successorTaskId) ?? 0) + 1);
  }

  const queue = activeLeafTasks.filter((task) => (inDegree.get(task.id) ?? 0) === 0).map((task) => task.id);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const successorId of outgoing.get(id) ?? []) {
      const nextDegree = (inDegree.get(successorId) ?? 0) - 1;
      inDegree.set(successorId, nextDegree);
      if (nextDegree === 0) queue.push(successorId);
    }
  }

  if (order.length !== activeLeafTasks.length) return new Set();

  const longestFinish = new Map<string, number>();

  for (const id of order) {
    const predecessors = incoming.get(id) ?? [];
    const longestPredecessorFinish = Math.max(
      0,
      ...predecessors.map((predecessorId) => longestFinish.get(predecessorId) ?? 0),
    );
    longestFinish.set(id, longestPredecessorFinish + (durationById.get(id) ?? 0));
  }

  const projectDuration = Math.max(...order.map((id) => longestFinish.get(id) ?? 0));
  const criticalIds = new Set<string>();
  const collectLongestPredecessors = (taskId: string, visiting = new Set<string>()) => {
    if (visiting.has(taskId)) return;
    const nextVisiting = new Set(visiting).add(taskId);
    criticalIds.add(taskId);
    const taskFinish = longestFinish.get(taskId) ?? 0;
    const ownDuration = durationById.get(taskId) ?? 0;
    for (const predecessorId of incoming.get(taskId) ?? []) {
      if ((longestFinish.get(predecessorId) ?? 0) + ownDuration === taskFinish) {
        collectLongestPredecessors(predecessorId, nextVisiting);
      }
    }
  };
  order
    .filter((taskId) => (longestFinish.get(taskId) ?? 0) === projectDuration)
    .forEach((taskId) => collectLongestPredecessors(taskId));

  return criticalIds;
};

/**
 * The scheduling service is the single CPM authority once it has calculated a
 * project. The local calculation is only a legacy fallback for unscheduled
 * imports, where no CPM metrics have been persisted yet.
 */
export const resolveGanttCriticalTaskIds = (
  tasks: ProjectGanttTask[],
  calendarMode: GanttCalendarMode = "CALENDAR_DAYS",
): Set<string> => {
  // Recalculate in memory so a page opened before the derived-state refresh
  // still reflects resource serialization immediately. Persisted metrics are
  // refreshed by the server with the same resource-aware CPM authority.
  const resourceAwareCpm = calculateResourceAwareGanttCpm(tasks, calendarMode);
  const parentTaskIds = new Set(tasks.flatMap((task) => task.parentId ? [task.parentId] : []));
  const hasPersistedCpm = tasks.some((task) => (
    !!task.scheduleCalculatedAt || !!String(task.scheduleStatus ?? "").trim()
  ));
  // Persisted CPM remains authoritative when no resource chain exists. The
  // in-memory resource calculation is only allowed to override it when there
  // is a real same-owner capacity constraint to account for.
  if (hasPersistedCpm && resourceAwareCpm.resourceLinks.length === 0) {
    return new Set(tasks
      .filter((task) => (
        !parentTaskIds.has(task.id)
        && Number(task.progress ?? 0) < 100
        && String(task.scheduleStatus ?? "").toUpperCase() === "CRITICAL"
        && Number(task.totalFloatMinutes) === 0
      ))
      .map((task) => task.id));
  }
  const resourceAwareCriticalIds = new Set(tasks
    .filter((task) => (
      !parentTaskIds.has(task.id)
      && Number(task.progress ?? 0) < 100
      && resourceAwareCpm.metricsByTaskId.get(task.id)?.isCritical
    ))
    .map((task) => task.id));
  if (resourceAwareCriticalIds.size > 0) return resourceAwareCriticalIds;

  if (!hasPersistedCpm) return findGanttCriticalTaskIds(tasks);

  return new Set(tasks
    .filter((task) => (
      !parentTaskIds.has(task.id)
      && Number(task.progress ?? 0) < 100
      && String(task.scheduleStatus ?? "").toUpperCase() === "CRITICAL"
      && Number(task.totalFloatMinutes) === 0
    ))
    .map((task) => task.id));
};

export const buildGanttRows = (
  tasks: ProjectGanttTask[],
  options: GanttDisplayOptions = {},
): GanttRow[] => {
  const coordinateMode = resolveGanttCoordinateMode(tasks, options.coordinateMode);
  const range = getGanttDateRange(tasks, { coordinateMode });
  const relativeOffsets = coordinateMode === "RELATIVE"
    ? tasks.flatMap((task) => [task.relativeStartOffsetDays, task.relativeFinishOffsetDays]
      .filter(isGanttRelativeOffset)
      .map(normalizeGanttRelativeOffset))
    : [];
  const relativeTimeline = {
    originOffsetDays: 0,
    totalDays: Math.max(1, (relativeOffsets.length > 0 ? Math.max(...relativeOffsets) : 0) + 1),
  };
  const hasRealDates = coordinateMode === "ABSOLUTE";
  const criticalIds = resolveGanttCriticalTaskIds(tasks, options.calendarMode);

  return tasks.map((task) => {
    const hasPlannedStart = hasRealDates && GANTT_DATE_PATTERN.test(task.startDate);
    const endDate = hasPlannedStart ? resolveGanttTaskEndDate(task) : "";
    // The timeline is a calendar axis. A 12-working-day task may occupy more
    // than 12 calendar cells, so explicit start/finish dates are authoritative
    // for the rendered bar width while duration remains the scheduling input.
    const spanDays = hasPlannedStart ? ganttTaskCalendarSpanDays(task, endDate) : 0;
    const hasRelativeStart = coordinateMode === "RELATIVE" && task.relativeStartOffsetDays != null;
    const relativeStart = hasRelativeStart ? task.relativeStartOffsetDays! - relativeTimeline.originOffsetDays : 0;
    const relativeFinishOffset = task.relativeFinishOffsetDays ?? (
      hasRelativeStart ? task.relativeStartOffsetDays! + Math.max(0, task.durationDays || 1) - 1 : null
    );
    const relativeFinish = relativeFinishOffset == null
      ? relativeStart
      : relativeFinishOffset - relativeTimeline.originOffsetDays;
    const resolvedSpanDays = hasPlannedStart
      ? spanDays
      : hasRelativeStart ? Math.max(1, relativeFinish - relativeStart + 1) : 0;
    const offsetDays = range && hasPlannedStart
      ? diffDaysInclusive(range.startDate, task.startDate) - 1
      : coordinateMode === "RELATIVE" && hasRelativeStart ? relativeStart : 0;
    const timelineTotalDays = range ? range.totalDays : relativeTimeline.totalDays;

    return {
      ...task,
      endDate,
      spanDays: resolvedSpanDays,
      offsetDays,
      timelineStartDays: offsetDays,
      timelineEndDays: offsetDays + resolvedSpanDays,
      startDisplayLabel: hasPlannedStart
        ? task.startDate
        : coordinateMode === "RELATIVE" ? formatGanttRelativeOffset(task.relativeStartOffsetDays) : "",
      finishDisplayLabel: hasPlannedStart
        ? endDate
        : coordinateMode === "RELATIVE" ? formatGanttRelativeOffset(relativeFinishOffset) : "",
      leftPercent: Math.round((offsetDays / timelineTotalDays) * 100),
      widthPercent: resolvedSpanDays > 0 ? Math.max(4, Math.round((resolvedSpanDays / timelineTotalDays) * 100)) : 0,
      isCritical: criticalIds.has(task.id),
    };
  });
};

const parsePredecessorNames = (value: string): string[] => (
  value
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter(Boolean)
);
