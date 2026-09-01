import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

export const EXECUTION_SCOPE_LINK_TYPES = ["DIRECT", "SUBTREE"] as const;
export type ExecutionScopeLinkType = (typeof EXECUTION_SCOPE_LINK_TYPES)[number];

export type ProjectExecutionScopeTask = {
  id: string;
  parentId: string | null;
  taskCode: string;
  taskName: string;
  taskCategory: string;
  startDate: string;
  finishDate: string;
  durationDays: number;
  estimatedWorkHours: number;
  progress: number;
  scheduleStatus: string;
  totalFloatMinutes: number | null;
};

export type ProjectExecutionScopeLink = {
  ganttTaskId: string;
  relationType: string;
};

export const projectExecutionInclude = {
  ownerMember: {
    select: { id: true, personName: true, roleName: true },
  },
  taskLinks: {
    orderBy: { createdAt: "asc" },
    include: {
      ganttTask: {
        select: {
          id: true,
          taskCode: true,
          taskName: true,
          taskCategory: true,
          parentId: true,
          startDate: true,
          finishDate: true,
          durationDays: true,
          estimatedWorkHours: true,
          progress: true,
          scheduleStatus: true,
          totalFloatMinutes: true,
        },
      },
    },
  },
} satisfies Prisma.ProjectExecutionInclude;

export type ProjectExecutionRecord = Prisma.ProjectExecutionGetPayload<{
  include: typeof projectExecutionInclude;
}>;

const scheduleValue = (value: string) => {
  const relative = value.match(/^T0(?:\+([0-9]+(?:\.[0-9]+)?))?$/iu);
  if (relative) return [0, Number(relative[1] ?? 0)] as const;
  const timestamp = Date.parse(value);
  return [1, Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp] as const;
};

export const compareExecutionScheduleValues = (left: string, right: string) => {
  const [leftKind, leftValue] = scheduleValue(left);
  const [rightKind, rightValue] = scheduleValue(right);
  return leftKind - rightKind || leftValue - rightValue;
};

export const normalizeExecutionScopeLinkType = (value: unknown): ExecutionScopeLinkType => (
  value === "SUBTREE" ? "SUBTREE" : "DIRECT"
);

const taskWeight = (task: Pick<ProjectExecutionScopeTask, "estimatedWorkHours" | "durationDays">) => {
  const hours = Number(task.estimatedWorkHours);
  if (Number.isFinite(hours) && hours > 0) return hours;
  const duration = Number(task.durationDays);
  return Number.isFinite(duration) && duration > 0 ? duration * 7.5 : 1;
};

const appendDescendants = (
  taskId: string,
  childrenByParentId: ReadonlyMap<string, string[]>,
  resolvedTaskIds: Set<string>,
) => {
  const pending = [taskId];
  while (pending.length > 0) {
    const currentId = pending.pop()!;
    if (resolvedTaskIds.has(currentId)) continue;
    resolvedTaskIds.add(currentId);
    pending.push(...(childrenByParentId.get(currentId) ?? []));
  }
};

export type ProjectExecutionScope = {
  directTaskIds: string[];
  subtreeRootTaskIds: string[];
  resolvedTaskIds: string[];
  effectiveTaskIds: string[];
  tasks: ProjectExecutionScopeTask[];
  effectiveTasks: ProjectExecutionScopeTask[];
  totalTaskCount: number;
  completedTaskCount: number;
  weightedProgress: number;
  planStart: string;
  planFinish: string;
  rangeHash: string;
};

export const resolveProjectExecutionScope = (
  links: readonly ProjectExecutionScopeLink[],
  allTasks: readonly ProjectExecutionScopeTask[],
): ProjectExecutionScope => {
  const taskById = new Map(allTasks.map((task) => [task.id, task]));
  const childrenByParentId = new Map<string, string[]>();
  allTasks.forEach((task) => {
    if (!task.parentId || !taskById.has(task.parentId)) return;
    childrenByParentId.set(task.parentId, [...(childrenByParentId.get(task.parentId) ?? []), task.id]);
  });

  const directTaskIds: string[] = [];
  const subtreeRootTaskIds: string[] = [];
  const resolvedTaskIds = new Set<string>();
  links.forEach((link) => {
    if (!taskById.has(link.ganttTaskId)) return;
    if (normalizeExecutionScopeLinkType(link.relationType) === "SUBTREE") {
      subtreeRootTaskIds.push(link.ganttTaskId);
      appendDescendants(link.ganttTaskId, childrenByParentId, resolvedTaskIds);
      return;
    }
    directTaskIds.push(link.ganttTaskId);
    resolvedTaskIds.add(link.ganttTaskId);
  });

  const resolvedIds = allTasks.map((task) => task.id).filter((taskId) => resolvedTaskIds.has(taskId));
  const tasks = resolvedIds.map((taskId) => taskById.get(taskId)!);
  const effectiveTasks = tasks.filter((task) => (
    !(childrenByParentId.get(task.id) ?? []).some((childId) => resolvedTaskIds.has(childId))
  ));
  const starts = effectiveTasks.map((task) => task.startDate).filter(Boolean).sort(compareExecutionScheduleValues);
  const finishes = effectiveTasks.map((task) => task.finishDate).filter(Boolean).sort(compareExecutionScheduleValues);
  const totalWeight = effectiveTasks.reduce((sum, task) => sum + taskWeight(task), 0);
  const weightedProgress = totalWeight > 0
    ? Math.round(effectiveTasks.reduce((sum, task) => sum + Math.max(0, Math.min(100, task.progress)) * taskWeight(task), 0) / totalWeight)
    : 0;
  const completedTaskCount = effectiveTasks.filter((task) => task.progress >= 100).length;
  const rangeHash = createHash("sha256")
    .update(JSON.stringify({
      links: links
        .map((link) => ({ taskId: link.ganttTaskId, relationType: normalizeExecutionScopeLinkType(link.relationType) }))
        .sort((left, right) => `${left.relationType}:${left.taskId}`.localeCompare(`${right.relationType}:${right.taskId}`)),
      effectiveTaskIds: effectiveTasks.map((task) => task.id).sort(),
    }))
    .digest("hex");

  return {
    directTaskIds: Array.from(new Set(directTaskIds)),
    subtreeRootTaskIds: Array.from(new Set(subtreeRootTaskIds)),
    resolvedTaskIds: resolvedIds,
    effectiveTaskIds: effectiveTasks.map((task) => task.id),
    tasks,
    effectiveTasks,
    totalTaskCount: effectiveTasks.length,
    completedTaskCount,
    weightedProgress,
    planStart: starts[0] ?? "",
    planFinish: finishes.at(-1) ?? "",
    rangeHash,
  };
};

export const serializeProjectExecution = (
  record: ProjectExecutionRecord,
  allTasks: readonly ProjectExecutionScopeTask[] = record.taskLinks.map((link) => link.ganttTask),
) => {
  const scope = resolveProjectExecutionScope(record.taskLinks, allTasks);
  return {
    id: record.id,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    projectId: record.projectId,
    name: record.name,
    type: record.type,
    ownerMemberId: record.ownerMemberId,
    status: record.status,
    description: record.description,
    sortOrder: record.sortOrder,
    ownerMember: record.ownerMember,
    taskLinks: record.taskLinks.map((link) => ({
      executionId: link.executionId,
      ganttTaskId: link.ganttTaskId,
      relationType: normalizeExecutionScopeLinkType(link.relationType),
      createdAt: link.createdAt.toISOString(),
      task: link.ganttTask,
    })),
    planStart: scope.planStart,
    planFinish: scope.planFinish,
    progress: scope.weightedProgress,
    scope: {
      directTaskIds: scope.directTaskIds,
      subtreeRootTaskIds: scope.subtreeRootTaskIds,
      resolvedTaskIds: scope.resolvedTaskIds,
      effectiveTaskIds: scope.effectiveTaskIds,
      totalTaskCount: scope.totalTaskCount,
      completedTaskCount: scope.completedTaskCount,
      weightedProgress: scope.weightedProgress,
      rangeHash: scope.rangeHash,
    },
  };
};

export const EXECUTION_TYPES = ["SHORT_TERM", "WORK_PACKAGE", "MILESTONE", "RELEASE"] as const;
export const EXECUTION_STATUSES = ["PLANNED", "IN_PROGRESS", "COMPLETED", "ARCHIVED"] as const;

export const normalizeExecutionType = (value: unknown) => (
  typeof value === "string" && EXECUTION_TYPES.includes(value as (typeof EXECUTION_TYPES)[number])
    ? value
    : "SHORT_TERM"
);

export const normalizeExecutionStatus = (value: unknown) => (
  typeof value === "string" && EXECUTION_STATUSES.includes(value as (typeof EXECUTION_STATUSES)[number])
    ? value
    : "PLANNED"
);

export const normalizeTaskIds = (value: unknown) => (
  Array.from(new Set(
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [],
  ))
);

export const normalizeExecutionScopeLinks = (value: unknown, legacyTaskIds?: unknown) => {
  const rawLinks = Array.isArray(value) ? value : [];
  if (rawLinks.length === 0 && legacyTaskIds !== undefined) {
    return normalizeTaskIds(legacyTaskIds).map((ganttTaskId) => ({ ganttTaskId, relationType: "DIRECT" as const }));
  }
  const links = new Map<string, { ganttTaskId: string; relationType: ExecutionScopeLinkType }>();
  rawLinks.forEach((raw) => {
    if (!raw || typeof raw !== "object") return;
    const link = raw as Record<string, unknown>;
    const ganttTaskId = String(link.ganttTaskId ?? link.taskId ?? "").trim();
    if (!ganttTaskId) return;
    const relationType = normalizeExecutionScopeLinkType(link.relationType);
    const current = links.get(ganttTaskId);
    links.set(ganttTaskId, current?.relationType === "SUBTREE" || relationType === "SUBTREE"
      ? { ganttTaskId, relationType: "SUBTREE" }
      : { ganttTaskId, relationType });
  });
  return [...links.values()];
};
