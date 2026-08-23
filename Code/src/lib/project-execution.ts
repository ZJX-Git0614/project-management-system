import type { Prisma } from "@prisma/client";

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
          progress: true,
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

const compareScheduleValues = (left: string, right: string) => {
  const [leftKind, leftValue] = scheduleValue(left);
  const [rightKind, rightValue] = scheduleValue(right);
  return leftKind - rightKind || leftValue - rightValue;
};

export const serializeProjectExecution = (record: ProjectExecutionRecord) => {
  const tasks = record.taskLinks.map((link) => link.ganttTask);
  const starts = tasks.map((task) => task.startDate).filter(Boolean).sort(compareScheduleValues);
  const finishes = tasks.map((task) => task.finishDate).filter(Boolean).sort(compareScheduleValues);
  const progress = tasks.length
    ? Math.round(tasks.reduce((sum, task) => sum + task.progress, 0) / tasks.length)
    : 0;

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
      relationType: link.relationType,
      createdAt: link.createdAt.toISOString(),
      task: link.ganttTask,
    })),
    planStart: starts[0] ?? "",
    planFinish: finishes.at(-1) ?? "",
    progress,
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
