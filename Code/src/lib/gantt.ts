import type { ProjectGanttTask } from "@/domain/models";
import {
  formatGanttRelativeOffset,
  isGanttRelativeOffset,
  normalizeGanttRelativeOffset,
} from "@/lib/gantt-relative-time";

export interface GanttDateRange {
  startDate: string;
  endDate: string;
  totalDays: number;
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

export const getGanttDateRange = (tasks: ProjectGanttTask[]): GanttDateRange | null => {
  if (tasks.length === 0) return null;

  // A schedule with unresolved T0 offsets is intentionally calendar-free.
  // Older imports can retain absolute dates alongside relative coordinates;
  // relative coordinates are authoritative until a project T0 is materialized.
  if (tasks.some((task) => (
    isGanttRelativeOffset(task.relativeStartOffsetDays)
    || isGanttRelativeOffset(task.relativeFinishOffsetDays)
  ))) return null;

  const datePairs = tasks
    .filter((task) => /^\d{4}-\d{2}-\d{2}$/.test(task.startDate))
    .map((task) => ({
      startDate: task.startDate,
      endDate: task.finishDate || addDaysInclusive(task.startDate, task.durationDays) || task.startDate,
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
  if (tasks.some((task) => task.totalFloatMinutes != null)) {
    return new Set(tasks
      .filter((task) => task.totalFloatMinutes != null && task.totalFloatMinutes <= 0)
      .map((task) => task.id));
  }

  const links = buildGanttDependencyLinks(tasks);
  const durationById = new Map(tasks.map((task) => [task.id, Math.max(0, task.durationDays)]));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const inDegree = new Map(tasks.map((task) => [task.id, 0]));

  for (const link of links) {
    outgoing.set(link.predecessorId, [...(outgoing.get(link.predecessorId) ?? []), link.successorId]);
    incoming.set(link.successorId, [...(incoming.get(link.successorId) ?? []), link.predecessorId]);
    inDegree.set(link.successorId, (inDegree.get(link.successorId) ?? 0) + 1);
  }

  const queue = tasks.filter((task) => (inDegree.get(task.id) ?? 0) === 0).map((task) => task.id);
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

  if (order.length !== tasks.length) return new Set();

  const longestDuration = new Map<string, number>();
  const bestPredecessor = new Map<string, string>();

  for (const id of order) {
    const predecessors = incoming.get(id) ?? [];
    let bestBefore = 0;
    for (const predecessorId of predecessors) {
      const candidate = longestDuration.get(predecessorId) ?? 0;
      if (candidate > bestBefore) {
        bestBefore = candidate;
        bestPredecessor.set(id, predecessorId);
      }
    }
    longestDuration.set(id, bestBefore + (durationById.get(id) ?? 0));
  }

  const endId = order.reduce((bestId, id) => (
    (longestDuration.get(id) ?? 0) > (longestDuration.get(bestId) ?? 0) ? id : bestId
  ), order[0]);

  const criticalIds = new Set<string>();
  let cursor: string | undefined = endId;
  while (cursor) {
    criticalIds.add(cursor);
    cursor = bestPredecessor.get(cursor);
  }

  return criticalIds;
};

export const buildGanttRows = (tasks: ProjectGanttTask[]): GanttRow[] => {
  const range = getGanttDateRange(tasks);
  const relativeOffsets = tasks.flatMap((task) => [task.relativeStartOffsetDays, task.relativeFinishOffsetDays]
    .filter(isGanttRelativeOffset)
    .map(normalizeGanttRelativeOffset));
  const relativeTimeline = {
    originOffsetDays: 0,
    totalDays: Math.max(1, (relativeOffsets.length > 0 ? Math.max(...relativeOffsets) : 0) + 1),
  };
  const hasRealDates = Boolean(range);
  const hasCalculatedFloat = tasks.some((task) => task.totalFloatMinutes != null);
  const criticalIds = hasCalculatedFloat
    ? new Set(tasks.filter((task) => (task.totalFloatMinutes ?? 1) <= 0).map((task) => task.id))
    : findGanttCriticalTaskIds(tasks);

  return tasks.map((task) => {
    const hasPlannedStart = hasRealDates && /^\d{4}-\d{2}-\d{2}$/.test(task.startDate);
    const endDate = hasPlannedStart
      ? task.finishDate || addDaysInclusive(task.startDate, task.durationDays) || task.startDate
      : "";
    const spanDays = hasPlannedStart ? Math.max(0, task.durationDays || 0) : 0;
    const hasRelativeStart = task.relativeStartOffsetDays != null;
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
      : !hasRealDates && hasRelativeStart ? relativeStart : 0;
    const timelineTotalDays = hasRealDates && range ? range.totalDays : relativeTimeline.totalDays;

    return {
      ...task,
      endDate,
      spanDays: resolvedSpanDays,
      offsetDays,
      timelineStartDays: offsetDays,
      timelineEndDays: offsetDays + resolvedSpanDays,
      startDisplayLabel: hasPlannedStart ? task.startDate : formatGanttRelativeOffset(task.relativeStartOffsetDays),
      finishDisplayLabel: hasPlannedStart ? endDate : formatGanttRelativeOffset(relativeFinishOffset),
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
