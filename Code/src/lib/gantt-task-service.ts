import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  assignMissingGanttTaskCodes,
  nextGanttTaskCode,
  orderGanttTasksByHierarchy,
  renumberGanttTaskCodes,
} from "@/lib/gantt-task-codes";
import {
  changeGanttTaskHierarchy,
  synchronizeGanttTaskCategories,
  type GanttHierarchyDirection,
} from "@/lib/gantt-hierarchy";
import { normalizeGanttCalendarMode, type GanttCalendarMode } from "@/lib/gantt-calendar";
import { calculateGanttCpm, type GanttCpmMetrics } from "@/lib/gantt-cpm";
import { scheduleGanttTasks } from "@/lib/gantt-schedule";
import { buildGanttOwnerIdentityIndex, buildGanttOwnerRollups } from "@/lib/gantt-owner-hierarchy";
import {
  resolveEffectiveGanttOwnerMemberId,
  synchronizeGanttOwnerHierarchy,
} from "@/lib/gantt-owner-service";

const ganttTaskInclude = {
  ownerMember: {
    select: { id: true, accountId: true, personName: true, roleName: true },
  },
  ownerLinks: {
    orderBy: { createdAt: "asc" },
    include: {
      projectMember: {
        select: { id: true, accountId: true, personName: true, roleName: true },
      },
    },
  },
  predecessorDependencies: {
    orderBy: { createdAt: "asc" },
    include: {
      predecessorTask: {
        select: { id: true, taskCode: true, taskName: true },
      },
    },
  },
} satisfies Prisma.ProjectGanttTaskInclude;

type GanttTaskRecord = Prisma.ProjectGanttTaskGetPayload<{ include: typeof ganttTaskInclude }>;
type GanttWriteClient = Prisma.TransactionClient | typeof prisma;

type GanttScheduleUpdate = {
  id: string;
  startDate: string;
  finishDate: string;
  durationDays: number;
  durationMinutes: number;
  estimatedWorkHours: number;
  metrics: GanttCpmMetrics;
};

const bulkUpdateGanttTaskCodes = async (
  client: GanttWriteClient,
  rows: Array<{ id: string; taskCode: string }>,
) => {
  if (rows.length === 0) return;
  await client.$executeRaw(Prisma.sql`
    UPDATE "ProjectGanttTask" AS target
    SET "taskCode" = source."taskCode",
        "updatedAt" = NOW()
    FROM (VALUES ${Prisma.join(rows.map((row) => Prisma.sql`(${row.id}::text, ${row.taskCode}::text)`) )})
      AS source("id", "taskCode")
    WHERE target."id" = source."id"
  `);
};

const bulkUpdateGanttSortOrders = async (
  client: GanttWriteClient,
  rows: Array<{ id: string; sortOrder: number }>,
) => {
  if (rows.length === 0) return;
  await client.$executeRaw(Prisma.sql`
    UPDATE "ProjectGanttTask" AS target
    SET "sortOrder" = source."sortOrder",
        "updatedAt" = NOW()
    FROM (VALUES ${Prisma.join(rows.map((row) => Prisma.sql`(${row.id}::text, ${row.sortOrder}::integer)`) )})
      AS source("id", "sortOrder")
    WHERE target."id" = source."id"
  `);
};

const bulkUpdateGanttStructure = async (
  client: GanttWriteClient,
  rows: Array<{ id: string; parentId: string | null; sortOrder: number; taskCategory: string }>,
) => {
  if (rows.length === 0) return;
  await client.$executeRaw(Prisma.sql`
    UPDATE "ProjectGanttTask" AS target
    SET "parentId" = source."parentId",
        "sortOrder" = source."sortOrder",
        "taskCategory" = source."taskCategory",
        "updatedAt" = NOW()
    FROM (VALUES ${Prisma.join(rows.map((row) => Prisma.sql`(
      ${row.id}::text,
      ${row.parentId}::text,
      ${row.sortOrder}::integer,
      ${row.taskCategory}::text
    )`) )}) AS source("id", "parentId", "sortOrder", "taskCategory")
    WHERE target."id" = source."id"
  `);
};

const bulkUpdateGanttSchedule = async (
  client: GanttWriteClient,
  rows: GanttScheduleUpdate[],
  calculatedAt: Date,
) => {
  if (rows.length === 0) return;
  await client.$executeRaw(Prisma.sql`
    UPDATE "ProjectGanttTask" AS target
    SET "startDate" = source."startDate",
        "finishDate" = source."finishDate",
        "durationDays" = source."durationDays",
        "durationMinutes" = source."durationMinutes",
        "estimatedWorkHours" = source."estimatedWorkHours",
        "earlyStartDate" = source."earlyStartDate",
        "earlyFinishDate" = source."earlyFinishDate",
        "lateStartDate" = source."lateStartDate",
        "lateFinishDate" = source."lateFinishDate",
        "totalFloatMinutes" = source."totalFloatMinutes",
        "freeFloatMinutes" = source."freeFloatMinutes",
        "scheduleStatus" = source."scheduleStatus",
        "scheduleCalculatedAt" = ${calculatedAt},
        "updatedAt" = NOW()
    FROM (VALUES ${Prisma.join(rows.map((row) => Prisma.sql`(
      ${row.id}::text,
      ${row.startDate}::text,
      ${row.finishDate}::text,
      ${row.durationDays}::double precision,
      ${row.durationMinutes}::integer,
      ${row.estimatedWorkHours}::double precision,
      ${row.metrics.earlyStartDate}::text,
      ${row.metrics.earlyFinishDate}::text,
      ${row.metrics.lateStartDate}::text,
      ${row.metrics.lateFinishDate}::text,
      ${row.metrics.totalFloatMinutes ?? null}::integer,
      ${row.metrics.freeFloatMinutes ?? null}::integer,
      ${row.metrics.scheduleStatus}::text
    )`) )}) AS source(
      "id", "startDate", "finishDate", "durationDays", "durationMinutes", "estimatedWorkHours",
      "earlyStartDate", "earlyFinishDate", "lateStartDate", "lateFinishDate",
      "totalFloatMinutes", "freeFloatMinutes", "scheduleStatus"
    )
    WHERE target."id" = source."id"
  `);
};

export const serializeGanttTask = (task: GanttTaskRecord) => {
  const predecessorTaskIds = task.predecessorDependencies.map((dependency) => dependency.predecessorTaskId);
  const predecessorNames = task.predecessorDependencies
    .map((dependency) => dependency.predecessorTask.taskName)
    .filter(Boolean);

  return {
    ...task,
    ownerMemberIds: (task.ownerLinks ?? []).length > 0
      ? (task.ownerLinks ?? []).map((link) => link.projectMemberId)
      : task.ownerMemberId ? [task.ownerMemberId] : [],
    predecessorTaskIds,
    predecessorTask: predecessorNames.length > 0 ? predecessorNames.join(",") : task.predecessorTask,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    scheduleCalculatedAt: task.scheduleCalculatedAt?.toISOString() ?? null,
    predecessorDependencies: task.predecessorDependencies.map((dependency) => ({
      ...dependency,
      createdAt: dependency.createdAt.toISOString(),
      updatedAt: dependency.updatedAt.toISOString(),
    })),
  };
};

export const serializeGanttTaskList = (tasks: GanttTaskRecord[]) => {
  const ownerMembersInTasks = [...new Map(tasks.flatMap((task) => [
    ...(task.ownerLinks ?? []).map((link) => link.projectMember),
    ...(task.ownerMember ? [task.ownerMember] : []),
  ]).map((member) => [member.id, member] as const)).values()];
  const ownerIdentityIndex = buildGanttOwnerIdentityIndex(ownerMembersInTasks);
  const ownerIdsByTaskId = buildGanttOwnerRollups(tasks.map((task) => ({
    id: task.id,
    parentId: task.parentId,
    ownerMemberId: task.ownerMemberId,
    ownerMemberIds: (task.ownerLinks ?? []).length > 0
      ? (task.ownerLinks ?? []).map((link) => link.projectMemberId)
      : task.ownerMemberId ? [task.ownerMemberId] : [],
  })), ownerIdentityIndex);
  const ownerMemberById = new Map(
    ownerMembersInTasks.map((ownerMember) => [ownerMember.id, ownerMember] as const),
  );
  const ownerMembershipsByIdentity = new Map<string, typeof ownerMembersInTasks>();
  ownerMembersInTasks.forEach((ownerMember) => {
    const identityKey = ownerIdentityIndex.get(ownerMember.id)?.identityKey ?? `member:${ownerMember.id}`;
    ownerMembershipsByIdentity.set(identityKey, [
      ...(ownerMembershipsByIdentity.get(identityKey) ?? []),
      ownerMember,
    ]);
  });
  const parentTaskIds = new Set(tasks.map((task) => task.parentId).filter((id): id is string => Boolean(id)));

  return tasks.map((task) => {
    const ownersByIdentity = new Map<string, {
      id: string;
      accountId: string | null;
      personName: string;
      roleName: string;
      roleNames: string[];
    }>();
    (ownerIdsByTaskId.get(task.id) ?? []).forEach((ownerMemberId) => {
      const owner = ownerMemberById.get(ownerMemberId);
      if (!owner) return;
      const identity = ownerIdentityIndex.get(ownerMemberId)?.identityKey ?? (owner.accountId || owner.personName);
      const roleNames = Array.from(new Set(
        (ownerMembershipsByIdentity.get(identity) ?? [owner]).map((membership) => membership.roleName),
      ));
      const existing = ownersByIdentity.get(identity);
      if (existing) {
        roleNames.forEach((roleName) => {
          if (!existing.roleNames.includes(roleName)) existing.roleNames.push(roleName);
        });
        existing.roleName = existing.roleNames.join("、");
        return;
      }
      ownersByIdentity.set(identity, { ...owner, roleName: roleNames.join("、"), roleNames });
    });
    const ownerMembers = Array.from(ownersByIdentity.values());
    return {
      ...serializeGanttTask(task),
      ownerMembers,
      ownerReadOnly: parentTaskIds.has(task.id) && ownerMembers.length > 0,
    };
  });
};

export const getOrderedGanttTasks = async (projectId: string) => {
  const tasks = await prisma.projectGanttTask.findMany({
    where: { projectId },
    orderBy: [{ sortOrder: "asc" }, { startDate: "asc" }, { createdAt: "asc" }],
    include: ganttTaskInclude,
  });
  const normalizedTasks = assignMissingGanttTaskCodes(tasks);
  const originalById = new Map(tasks.map((task) => [task.id, task]));
  const taskCodeUpdates = normalizedTasks.filter((task) => {
    const original = originalById.get(task.id);
    return original && original.taskCode !== task.taskCode;
  });

  await bulkUpdateGanttTaskCodes(prisma, taskCodeUpdates);

  return orderGanttTasksByHierarchy(normalizedTasks);
};

export const getProjectGanttCalendarMode = async (
  projectId: string,
  client: GanttWriteClient = prisma,
): Promise<GanttCalendarMode> => {
  const project = await client.project.findUnique({
    where: { id: projectId },
    select: { ganttCalendarMode: true },
  });
  return normalizeGanttCalendarMode(project?.ganttCalendarMode);
};

export const recalculateProjectGanttSchedule = async (
  projectId: string,
  requestedMode?: GanttCalendarMode,
  client: GanttWriteClient = prisma,
) => {
  const mode = requestedMode ?? await getProjectGanttCalendarMode(projectId, client);
  const [project, currentTasks] = await Promise.all([
    client.project.findUnique({ where: { id: projectId }, select: { expectedEndDate: true } }),
    client.projectGanttTask.findMany({
    where: { projectId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    include: {
      predecessorDependencies: {
        select: { predecessorTaskId: true, type: true, lag: true, lagFormat: true },
      },
    },
    }),
  ]);
  const scheduled = scheduleGanttTasks(currentTasks, mode);
  const cpm = calculateGanttCpm(scheduled, mode, project?.expectedEndDate ?? "");
  const currentById = new Map(currentTasks.map((task) => [task.id, task]));
  const updates = scheduled.flatMap((task) => {
    const current = currentById.get(task.id)!;
    const metrics = cpm.metricsByTaskId.get(task.id);
    if (!metrics) return [];
    const changed = current.startDate !== task.startDate
      || current.finishDate !== task.finishDate
      || current.durationDays !== task.durationDays
      || current.durationMinutes !== task.durationMinutes
      || Math.abs(current.estimatedWorkHours - (task.estimatedWorkHours ?? task.durationDays * 7.5)) > 0.001
      || current.earlyStartDate !== metrics.earlyStartDate
      || current.earlyFinishDate !== metrics.earlyFinishDate
      || current.lateStartDate !== metrics.lateStartDate
      || current.lateFinishDate !== metrics.lateFinishDate
      || current.totalFloatMinutes !== metrics.totalFloatMinutes
      || current.freeFloatMinutes !== metrics.freeFloatMinutes
      || current.scheduleStatus !== metrics.scheduleStatus;
    return changed ? [{
      id: task.id,
      startDate: task.startDate,
      finishDate: task.finishDate,
      durationDays: task.durationDays,
      durationMinutes: task.durationMinutes ?? Math.round(task.durationDays * 450),
      estimatedWorkHours: task.estimatedWorkHours ?? task.durationDays * 7.5,
      metrics,
    }] : [];
  });

  await bulkUpdateGanttSchedule(client, updates, new Date());
  return mode;
};

export const replaceGanttTaskDependencies = async (
  tx: Prisma.TransactionClient,
  projectId: string,
  successorTaskId: string,
  dependencies: Array<{ predecessorTaskId: string; type?: number; lag?: number; lagFormat?: number }>,
) => {
  const uniqueDependencies = [...new Map(
    dependencies
      .filter((dependency) => dependency.predecessorTaskId && dependency.predecessorTaskId !== successorTaskId)
      .map((dependency) => [dependency.predecessorTaskId, dependency]),
  ).values()];

  if (uniqueDependencies.length > 0) {
    const validCount = await tx.projectGanttTask.count({
      where: {
        projectId,
        id: { in: uniqueDependencies.map((dependency) => dependency.predecessorTaskId) },
      },
    });
    if (validCount !== uniqueDependencies.length) {
      throw new Error("紧前任务不存在或不属于当前项目");
    }
  }

  await tx.projectGanttDependency.deleteMany({ where: { successorTaskId } });
  if (uniqueDependencies.length === 0) return;

  await tx.projectGanttDependency.createMany({
    data: uniqueDependencies.map((dependency) => ({
      projectId,
      successorTaskId,
      predecessorTaskId: dependency.predecessorTaskId,
      type: Number.isInteger(dependency.type) ? dependency.type! : 1,
      lag: Number.isInteger(dependency.lag) ? dependency.lag! : 0,
      lagFormat: Number.isInteger(dependency.lagFormat) ? dependency.lagFormat! : 7,
    })),
  });
};

export const parseGanttDependencyInput = (body: Record<string, unknown>) => {
  if (Array.isArray(body.predecessorDependencies)) {
    return body.predecessorDependencies.map((value) => {
      const dependency = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return {
        predecessorTaskId: String(dependency.predecessorTaskId ?? "").trim(),
        type: Number(dependency.type ?? 1),
        lag: Number(dependency.lag ?? 0),
        lagFormat: Number(dependency.lagFormat ?? 7),
      };
    });
  }

  const ids = Array.isArray(body.predecessorTaskIds)
    ? body.predecessorTaskIds
    : body.predecessorTaskId
      ? [body.predecessorTaskId]
      : [];
  return ids.map((value) => ({ predecessorTaskId: String(value).trim(), type: 1, lag: 0, lagFormat: 7 }));
};

export const getNextGanttTaskCode = async (projectId: string, parentId: string | null) => {
  const tasks = await getOrderedGanttTasks(projectId);
  return nextGanttTaskCode(tasks, parentId);
};

export const renumberProjectGanttTaskCodes = async (
  projectId: string,
  client: GanttWriteClient = prisma,
) => {
  const tasks = await client.projectGanttTask.findMany({
    where: { projectId },
    orderBy: [{ sortOrder: "asc" }, { startDate: "asc" }, { createdAt: "asc" }],
  });
  const renumberedTasks = renumberGanttTaskCodes(tasks);
  const originalById = new Map(tasks.map((task) => [task.id, task]));
  const updates = renumberedTasks.filter((task) => {
    const original = originalById.get(task.id);
    return original && original.taskCode !== task.taskCode;
  });

  await bulkUpdateGanttTaskCodes(client, updates);
};

type GanttTaskHierarchyRecord = {
  id: string;
  parentId: string | null;
};

/**
 * Resolves hierarchy depth without trusting task codes, which are derived display values.
 * Orphaned and cyclic records are treated as roots so a cleanup never cascades unexpectedly.
 */
export const ganttTaskDepthById = (tasks: GanttTaskHierarchyRecord[]) => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const resolved = new Map<string, number>();

  const depthOf = (taskId: string, path = new Set<string>()): number => {
    const cached = resolved.get(taskId);
    if (cached !== undefined) return cached;
    const task = byId.get(taskId);
    if (path.has(taskId)) {
      path.forEach((id) => resolved.set(id, 1));
      return 1;
    }
    if (!task?.parentId || !byId.has(task.parentId)) {
      resolved.set(taskId, 1);
      return 1;
    }
    const nextPath = new Set(path);
    nextPath.add(taskId);
    const parentDepth = depthOf(task.parentId, nextPath);
    const normalized = resolved.get(taskId);
    if (normalized !== undefined) return normalized;
    const depth = parentDepth + 1;
    resolved.set(taskId, depth);
    return depth;
  };

  tasks.forEach((task) => depthOf(task.id));
  return resolved;
};

export const ganttTaskIdsAtOrBeyondDepth = (
  tasks: GanttTaskHierarchyRecord[],
  minimumDepth: number,
) => {
  const depths = ganttTaskDepthById(tasks);
  return tasks
    .filter((task) => (depths.get(task.id) ?? 1) >= minimumDepth)
    .map((task) => task.id);
};

export const ganttTaskSubtreeIds = (tasks: GanttTaskHierarchyRecord[], rootTaskIds: string[]) => {
  const childrenByParentId = new Map<string, string[]>();
  tasks.forEach((task) => {
    if (!task.parentId) return;
    childrenByParentId.set(task.parentId, [...(childrenByParentId.get(task.parentId) ?? []), task.id]);
  });
  const pending = [...new Set(rootTaskIds)];
  const selected = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (selected.has(current)) continue;
    selected.add(current);
    pending.push(...(childrenByParentId.get(current) ?? []));
  }
  return tasks.filter((task) => selected.has(task.id)).map((task) => task.id);
};

export class GanttRevisionConflictError extends Error {
  code = "GANTT_CHANGED";

  constructor(message = "甘特任务已被其他用户修改，请刷新后重试") {
    super(message);
    this.name = "GanttRevisionConflictError";
  }
}

const GANTT_DELETION_RETENTION_DAYS = 30;

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value || "") as T;
  } catch {
    return fallback;
  }
};

const uniqueNonEmptyIds = (ids: string[]) => [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];

type GanttDeletionSummary = {
  rootTaskIds: string[];
  rootTasks: Array<{ id: string; taskCode: string; taskName: string }>;
  taskIds: string[];
  deletedTaskCount: number;
  descendantTaskCount: number;
  dependencyCount: number;
  internalDependencyCount: number;
  externalDependencyCount: number;
  detachedWeeklyItemCount: number;
  detachedRiskCount: number;
  affectedRiskCount: number;
  clearedPredecessorCount: number;
  ganttRevision: number;
};

type GanttDeletionSnapshot = {
  version: 1;
  tasks: Array<Record<string, unknown>>;
  dependencies: Array<Record<string, unknown>>;
  weeklyLinks: Array<{ id: string; ganttTaskId: string | null; taskName: string }>;
  weeklyTaskLinks?: Array<{ weeklyItemId: string; ganttTaskId: string }>;
  riskLinks?: Array<{ id: string; ganttTaskId: string | null; linkedItemName: string }>;
  summary: GanttDeletionSummary;
};

type GanttPlanHistorySnapshot = {
  version: 1;
  project: { ganttCalendarMode: string };
  tasks: Array<Record<string, unknown>>;
  dependencies: Array<Record<string, unknown>>;
  weeklyLinks: Array<{ id: string; ganttTaskId: string | null; taskName: string }>;
  weeklyTaskLinks?: Array<{ weeklyItemId: string; ganttTaskId: string }>;
  riskLinks?: Array<{ id: string; ganttTaskId: string | null; linkedItemName: string }>;
  scheduleMetadata: Record<string, unknown> | null;
};

const GANTT_HISTORY_SOURCE_PREFIX = "__gantt_history__";
const GANTT_HISTORY_SNAPSHOT_LIMIT = 110;

const synchronizeWeeklyItemLegacyTaskFields = async (
  client: GanttWriteClient,
  projectId: string,
  weeklyItemIds: string[],
) => {
  const itemIds = uniqueNonEmptyIds(weeklyItemIds);
  if (itemIds.length === 0) return;

  const [items, links] = await Promise.all([
    client.weeklyItem.findMany({
      where: { projectId, id: { in: itemIds } },
      select: { id: true },
    }),
    client.weeklyItemGanttTask.findMany({
      where: { weeklyItemId: { in: itemIds }, weeklyItem: { projectId } },
      select: {
        weeklyItemId: true,
        ganttTask: { select: { id: true, taskName: true, sortOrder: true } },
      },
    }),
  ]);
  const linksByItemId = new Map<string, typeof links>();
  links.forEach((link) => {
    linksByItemId.set(link.weeklyItemId, [...(linksByItemId.get(link.weeklyItemId) ?? []), link]);
  });

  await Promise.all(items.map((item) => {
    const firstLink = (linksByItemId.get(item.id) ?? [])
      .sort((left, right) => left.ganttTask.sortOrder - right.ganttTask.sortOrder
        || left.ganttTask.id.localeCompare(right.ganttTask.id))[0];
    return client.weeklyItem.update({
      where: { id: item.id },
      data: {
        ganttTaskId: firstLink?.ganttTask.id ?? null,
        taskName: firstLink?.ganttTask.taskName ?? "",
      },
    });
  }));
};

const taskScalarSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  projectId: true,
  parentId: true,
  ownerMemberId: true,
  ownerLinks: {
    orderBy: { createdAt: "asc" },
    select: { projectMemberId: true },
  },
  taskCode: true,
  taskCategory: true,
  taskName: true,
  taskDescription: true,
  startDate: true,
  finishDate: true,
  durationDays: true,
  durationMinutes: true,
  durationFormat: true,
  actualStartDate: true,
  actualEndDate: true,
  estimatedWorkHours: true,
  actualWorkHours: true,
  progress: true,
  predecessorTask: true,
  taskMode: true,
  isMilestone: true,
  externalUid: true,
  wbsCode: true,
  outlineNumber: true,
  calendarUid: true,
  constraintType: true,
  constraintDate: true,
  resourceNotBeforeDate: true,
  baselineStartDate: true,
  baselineFinishDate: true,
  baselineCost: true,
  budgetAtCompletion: true,
  actualCost: true,
  budgetItemId: true,
  baselines: true,
  remark: true,
  sortOrder: true,
} satisfies Prisma.ProjectGanttTaskSelect;

export const ganttSnapshotOwnerMemberIds = (task: Record<string, unknown>) => {
  const ownerLinks = Array.isArray(task.ownerLinks) ? task.ownerLinks : [];
  const linkedOwnerIds = ownerLinks
    .map((link) => link && typeof link === "object" && "projectMemberId" in link
      ? String(link.projectMemberId ?? "").trim()
      : "")
    .filter(Boolean);
  if (linkedOwnerIds.length > 0) return [...new Set(linkedOwnerIds)];
  const legacyOwnerId = typeof task.ownerMemberId === "string" ? task.ownerMemberId.trim() : "";
  return legacyOwnerId ? [legacyOwnerId] : [];
};

export const ganttSnapshotOwnerLinkRows = (
  tasks: Array<Record<string, unknown>>,
  validOwnerIds: ReadonlySet<string>,
) => tasks.flatMap((task) => ganttSnapshotOwnerMemberIds(task)
  .filter((projectMemberId) => validOwnerIds.has(projectMemberId))
  .map((projectMemberId) => ({ taskId: String(task.id), projectMemberId })));

const dependencyScalarSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  projectId: true,
  predecessorTaskId: true,
  successorTaskId: true,
  type: true,
  lag: true,
  lagFormat: true,
} satisfies Prisma.ProjectGanttDependencySelect;

const scheduleMetadataScalarSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  projectId: true,
  sourceFileName: true,
  projectSettings: true,
  calendars: true,
  resources: true,
  assignments: true,
  taskUidMap: true,
} satisfies Prisma.ProjectScheduleImportMetadataSelect;

const snapshotTaskDepth = (task: Record<string, unknown>, byId: Map<string, Record<string, unknown>>) => {
  let depth = 0;
  let parentId = typeof task.parentId === "string" ? task.parentId : null;
  const visited = new Set<string>();
  while (parentId && byId.has(parentId) && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = typeof byId.get(parentId)?.parentId === "string" ? String(byId.get(parentId)?.parentId) : null;
  }
  return depth;
};

const taskSnapshotCreateData = (
  rawTask: Record<string, unknown>,
  projectId: string,
  validOwnerIds: ReadonlySet<string>,
  validBudgetIds: ReadonlySet<string>,
  validParentIds: ReadonlySet<string>,
): Prisma.ProjectGanttTaskCreateManyInput => {
  const rawParentId = typeof rawTask.parentId === "string" ? rawTask.parentId : null;
  const ownerMemberIds = ganttSnapshotOwnerMemberIds(rawTask).filter((ownerId) => validOwnerIds.has(ownerId));
  const rawBudgetItemId = typeof rawTask.budgetItemId === "string" ? rawTask.budgetItemId : null;
  return {
    id: String(rawTask.id),
    createdAt: new Date(String(rawTask.createdAt)),
    updatedAt: new Date(String(rawTask.updatedAt)),
    projectId,
    parentId: rawParentId && validParentIds.has(rawParentId) ? rawParentId : null,
    ownerMemberId: ownerMemberIds.length === 1 ? ownerMemberIds[0] : null,
    taskCode: String(rawTask.taskCode ?? ""),
    taskCategory: String(rawTask.taskCategory ?? ""),
    taskName: String(rawTask.taskName ?? ""),
    taskDescription: String(rawTask.taskDescription ?? "").trim() || "无",
    startDate: String(rawTask.startDate ?? ""),
    finishDate: String(rawTask.finishDate ?? ""),
    durationDays: Number(rawTask.durationDays ?? 0),
    durationMinutes: Number(rawTask.durationMinutes ?? 0),
    durationFormat: Number(rawTask.durationFormat ?? 7),
    actualStartDate: String(rawTask.actualStartDate ?? ""),
    actualEndDate: String(rawTask.actualEndDate ?? ""),
    estimatedWorkHours: Number(rawTask.estimatedWorkHours ?? 0),
    actualWorkHours: Number(rawTask.actualWorkHours ?? 0),
    progress: Number(rawTask.progress ?? 0),
    predecessorTask: String(rawTask.predecessorTask ?? ""),
    taskMode: String(rawTask.taskMode ?? "AUTO"),
    isMilestone: Boolean(rawTask.isMilestone ?? false),
    externalUid: String(rawTask.externalUid ?? ""),
    wbsCode: String(rawTask.wbsCode ?? ""),
    outlineNumber: String(rawTask.outlineNumber ?? ""),
    calendarUid: String(rawTask.calendarUid ?? ""),
    constraintType: rawTask.constraintType === null || rawTask.constraintType === undefined ? null : Number(rawTask.constraintType),
    constraintDate: String(rawTask.constraintDate ?? ""),
    resourceNotBeforeDate: String(rawTask.resourceNotBeforeDate ?? ""),
    baselineStartDate: String(rawTask.baselineStartDate ?? ""),
    baselineFinishDate: String(rawTask.baselineFinishDate ?? ""),
    baselineCost: Number(rawTask.baselineCost ?? 0),
    budgetAtCompletion: Number(rawTask.budgetAtCompletion ?? 0),
    actualCost: Number(rawTask.actualCost ?? 0),
    budgetItemId: rawBudgetItemId && validBudgetIds.has(rawBudgetItemId) ? rawBudgetItemId : null,
    baselines: (rawTask.baselines ?? []) as Prisma.InputJsonValue,
    remark: String(rawTask.remark ?? ""),
    sortOrder: Number(rawTask.sortOrder ?? 0),
  };
};

export const captureProjectGanttHistorySnapshot = async (params: {
  projectId: string;
  sessionId: string;
  label: string;
  operator: string;
}) => {
  const sessionId = params.sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!sessionId) throw new Error("操作历史会话无效");

  // There is no concurrent plan editing yet, so parallel reads are both safe and
  // substantially faster than serializing full-plan queries on one transaction connection.
  const [project, tasks, dependencies, weeklyLinks, weeklyTaskLinks, riskLinks, scheduleMetadata] = await Promise.all([
    prisma.project.findUnique({ where: { id: params.projectId }, select: { ganttCalendarMode: true } }),
    prisma.projectGanttTask.findMany({ where: { projectId: params.projectId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }], select: taskScalarSelect }),
    prisma.projectGanttDependency.findMany({ where: { projectId: params.projectId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: dependencyScalarSelect }),
    prisma.weeklyItem.findMany({ where: { projectId: params.projectId, ganttTaskId: { not: null } }, select: { id: true, ganttTaskId: true, taskName: true } }),
    prisma.weeklyItemGanttTask.findMany({
      where: { weeklyItem: { projectId: params.projectId } },
      orderBy: [{ createdAt: "asc" }, { ganttTaskId: "asc" }],
      select: { weeklyItemId: true, ganttTaskId: true },
    }),
    prisma.riskRegisterItem.findMany({ where: { projectId: params.projectId, ganttTaskId: { not: null } }, select: { id: true, ganttTaskId: true, linkedItemName: true } }),
    prisma.projectScheduleImportMetadata.findUnique({ where: { projectId: params.projectId }, select: scheduleMetadataScalarSelect }),
  ]);
  if (!project) throw new Error("项目不存在");
  const payload: GanttPlanHistorySnapshot = {
    version: 1,
    project,
    tasks,
    dependencies,
    weeklyLinks,
    weeklyTaskLinks,
    riskLinks,
    scheduleMetadata,
  };
  const snapshot = await prisma.projectScheduleSnapshot.create({
    data: {
      projectId: params.projectId,
      sourceFileName: `${GANTT_HISTORY_SOURCE_PREFIX}:${sessionId}:${params.label.slice(0, 80)}`,
      schemaVersion: "gantt-history-1",
      normalizedJson: JSON.stringify(payload),
      createdBy: params.operator,
    },
    select: { id: true, createdAt: true },
  });

  const staleSnapshots = await prisma.projectScheduleSnapshot.findMany({
    where: {
      projectId: params.projectId,
      sourceFileName: { startsWith: `${GANTT_HISTORY_SOURCE_PREFIX}:${sessionId}:` },
    },
    orderBy: { createdAt: "desc" },
    skip: GANTT_HISTORY_SNAPSHOT_LIMIT,
    select: { id: true },
  });
  if (staleSnapshots.length > 0) {
    await prisma.projectScheduleSnapshot.deleteMany({ where: { id: { in: staleSnapshots.map((item) => item.id) } } });
  }
  return { snapshotId: snapshot.id, createdAt: snapshot.createdAt.toISOString() };
};

export const restoreProjectGanttHistorySnapshot = async (params: {
  projectId: string;
  snapshotId: string;
  operator: string;
  actionLabel: string;
}) => {
  const snapshotRecord = await prisma.projectScheduleSnapshot.findFirst({
    where: {
      id: params.snapshotId,
      projectId: params.projectId,
      schemaVersion: "gantt-history-1",
      sourceFileName: { startsWith: `${GANTT_HISTORY_SOURCE_PREFIX}:` },
    },
  });
  if (!snapshotRecord) throw new Error("撤销快照不存在或已过期");
  const snapshot = parseJson<GanttPlanHistorySnapshot | null>(snapshotRecord.normalizedJson, null);
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.dependencies)) {
    throw new Error("撤销快照内容不可用");
  }

  const result = await prisma.$transaction(async (tx) => {
    const project = await tx.project.findUniqueOrThrow({
      where: { id: params.projectId },
      select: { name: true, code: true },
    });
    const ownerIds = [...new Set(snapshot.tasks.flatMap(ganttSnapshotOwnerMemberIds))];
    const budgetIds = [...new Set(snapshot.tasks.map((task) => typeof task.budgetItemId === "string" ? task.budgetItemId : "").filter(Boolean))];
    const [owners, budgetItems, currentTasks, currentWeeklyTaskLinks] = await Promise.all([
      ownerIds.length ? tx.projectMember.findMany({ where: { projectId: params.projectId, id: { in: ownerIds } }, select: { id: true } }) : Promise.resolve([]),
      budgetIds.length ? tx.projectBudgetItem.findMany({ where: { projectId: params.projectId, id: { in: budgetIds } }, select: { id: true } }) : Promise.resolve([]),
      tx.projectGanttTask.findMany({ where: { projectId: params.projectId }, select: { id: true } }),
      tx.weeklyItemGanttTask.findMany({
        where: { weeklyItem: { projectId: params.projectId } },
        select: { weeklyItemId: true, ganttTaskId: true },
      }),
    ]);
    const validOwnerIds = new Set(owners.map((item) => item.id));
    const validBudgetIds = new Set(budgetItems.map((item) => item.id));
    const taskById = new Map(snapshot.tasks.map((task) => [String(task.id), task]));
    const taskIds = new Set(taskById.keys());
    const stableTaskIds = new Set(currentTasks.map((task) => task.id).filter((taskId) => taskIds.has(taskId)));
    const tasksByDepth = new Map<number, Array<Record<string, unknown>>>();
    snapshot.tasks.forEach((task) => {
      const depth = snapshotTaskDepth(task, taskById);
      tasksByDepth.set(depth, [...(tasksByDepth.get(depth) ?? []), task]);
    });

    await Promise.all([
      tx.weeklyItem.updateMany({ where: { projectId: params.projectId, ganttTaskId: { not: null } }, data: { ganttTaskId: null, taskName: "" } }),
      tx.riskRegisterItem.updateMany({ where: { projectId: params.projectId, ganttTaskId: { not: null } }, data: { ganttTaskId: null, linkedItemName: "" } }),
    ]);
    await tx.projectGanttDependency.deleteMany({ where: { projectId: params.projectId } });
    await tx.projectGanttTask.deleteMany({ where: { projectId: params.projectId } });

    for (const depth of [...tasksByDepth.keys()].sort((left, right) => left - right)) {
      const rows = tasksByDepth.get(depth) ?? [];
      if (rows.length === 0) continue;
      await tx.projectGanttTask.createMany({
        data: rows.map((task) => taskSnapshotCreateData(task, params.projectId, validOwnerIds, validBudgetIds, taskIds)),
      });
    }

    const ownerLinkRows = ganttSnapshotOwnerLinkRows(snapshot.tasks, validOwnerIds);
    if (ownerLinkRows.length > 0) {
      await tx.projectGanttTaskOwner.createMany({ data: ownerLinkRows, skipDuplicates: true });
    }

    const dependencies = snapshot.dependencies
      .filter((dependency) => taskIds.has(String(dependency.predecessorTaskId)) && taskIds.has(String(dependency.successorTaskId)))
      .map((dependency): Prisma.ProjectGanttDependencyCreateManyInput => ({
        id: String(dependency.id),
        createdAt: new Date(String(dependency.createdAt)),
        updatedAt: new Date(String(dependency.updatedAt)),
        projectId: params.projectId,
        predecessorTaskId: String(dependency.predecessorTaskId),
        successorTaskId: String(dependency.successorTaskId),
        type: Number(dependency.type ?? 1),
        lag: Number(dependency.lag ?? 0),
        lagFormat: Number(dependency.lagFormat ?? 7),
      }));
    if (dependencies.length > 0) await tx.projectGanttDependency.createMany({ data: dependencies });

    const snapshotWeeklyTaskLinks = Array.isArray(snapshot.weeklyTaskLinks)
      ? snapshot.weeklyTaskLinks
      : (snapshot.weeklyLinks ?? []).flatMap((link) => (
        link.ganttTaskId ? [{ weeklyItemId: link.id, ganttTaskId: link.ganttTaskId }] : []
      ));
    const targetOnlyTaskIds = new Set([...taskIds].filter((taskId) => !stableTaskIds.has(taskId)));
    const desiredWeeklyTaskLinks = new Map<string, { weeklyItemId: string; ganttTaskId: string }>();
    currentWeeklyTaskLinks.forEach((link) => {
      if (stableTaskIds.has(link.ganttTaskId)) desiredWeeklyTaskLinks.set(`${link.weeklyItemId}:${link.ganttTaskId}`, link);
    });
    snapshotWeeklyTaskLinks.forEach((link) => {
      if (targetOnlyTaskIds.has(link.ganttTaskId)) desiredWeeklyTaskLinks.set(`${link.weeklyItemId}:${link.ganttTaskId}`, link);
    });
    const desiredWeeklyLinks = [...desiredWeeklyTaskLinks.values()];
    const snapshotWeeklyItemIds = uniqueNonEmptyIds(desiredWeeklyLinks.map((link) => link.weeklyItemId));
    const existingWeeklyItems = snapshotWeeklyItemIds.length > 0
      ? await tx.weeklyItem.findMany({
        where: { projectId: params.projectId, id: { in: snapshotWeeklyItemIds } },
        select: { id: true },
      })
      : [];
    const existingWeeklyItemIds = new Set(existingWeeklyItems.map((item) => item.id));
    const restorableWeeklyTaskLinks = desiredWeeklyLinks.filter((link) => (
      existingWeeklyItemIds.has(link.weeklyItemId) && taskIds.has(link.ganttTaskId)
    ));
    if (restorableWeeklyTaskLinks.length > 0) {
      await tx.weeklyItemGanttTask.createMany({ data: restorableWeeklyTaskLinks, skipDuplicates: true });
    }
    await synchronizeWeeklyItemLegacyTaskFields(tx, params.projectId, snapshotWeeklyItemIds);

    if (snapshot.scheduleMetadata) {
      const metadata = snapshot.scheduleMetadata;
      await tx.projectScheduleImportMetadata.upsert({
        where: { projectId: params.projectId },
        create: {
          id: String(metadata.id),
          createdAt: new Date(String(metadata.createdAt)),
          updatedAt: new Date(String(metadata.updatedAt)),
          projectId: params.projectId,
          sourceFileName: String(metadata.sourceFileName ?? ""),
          projectSettings: (metadata.projectSettings ?? {}) as Prisma.InputJsonValue,
          calendars: (metadata.calendars ?? {}) as Prisma.InputJsonValue,
          resources: (metadata.resources ?? {}) as Prisma.InputJsonValue,
          assignments: (metadata.assignments ?? {}) as Prisma.InputJsonValue,
          taskUidMap: (metadata.taskUidMap ?? {}) as Prisma.InputJsonValue,
        },
        update: {
          sourceFileName: String(metadata.sourceFileName ?? ""),
          projectSettings: (metadata.projectSettings ?? {}) as Prisma.InputJsonValue,
          calendars: (metadata.calendars ?? {}) as Prisma.InputJsonValue,
          resources: (metadata.resources ?? {}) as Prisma.InputJsonValue,
          assignments: (metadata.assignments ?? {}) as Prisma.InputJsonValue,
          taskUidMap: (metadata.taskUidMap ?? {}) as Prisma.InputJsonValue,
        },
      });
    } else {
      await tx.projectScheduleImportMetadata.deleteMany({ where: { projectId: params.projectId } });
    }

    await synchronizeGanttOwnerHierarchy({ tx, projectId: params.projectId });

    await tx.project.update({
      where: { id: params.projectId },
      data: {
        ganttCalendarMode: snapshot.project.ganttCalendarMode,
        ganttRevision: { increment: 1 },
      },
    });
    const detail = `${params.actionLabel}：按操作快照恢复 ${snapshot.tasks.length} 条甘特任务和 ${dependencies.length} 条依赖。`;
    await Promise.all([
      tx.operationHistory.create({
        data: { projectId: params.projectId, entityType: "PROJECT_GANTT_TASK", entityId: params.snapshotId, actionType: "RESTORE", operator: params.operator, detail },
      }),
      tx.adminAuditLog.create({
        data: { actionType: "RESTORE_GANTT_HISTORY", operator: params.operator, projectId: params.projectId, projectName: project.name || project.code, detail },
      }),
    ]);
    const warnings: string[] = [];
    const skippedOwnerLinkCount = snapshot.tasks.flatMap(ganttSnapshotOwnerMemberIds).length - ownerLinkRows.length;
    if (skippedOwnerLinkCount > 0) warnings.push(`${skippedOwnerLinkCount} 条负责人关联因项目成员不存在而未恢复`);
    const skippedWeeklyLinkCount = desiredWeeklyLinks.length - restorableWeeklyTaskLinks.length;
    if (skippedWeeklyLinkCount > 0) warnings.push(`${skippedWeeklyLinkCount} 条事项关联因事项不存在而未恢复`);
    return { restoredTaskCount: snapshot.tasks.length, restoredDependencyCount: dependencies.length, warnings };
  }, { timeout: 30_000, maxWait: 10_000 });

  return { message: params.actionLabel, ...result };
};

export const markProjectGanttChanged = async (projectId: string) => {
  await prisma.project.update({
    where: { id: projectId },
    data: { ganttRevision: { increment: 1 } },
    select: { id: true },
  });
};

const collectGanttDeletionSummary = async (
  projectId: string,
  rootTaskIds: string[],
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<GanttDeletionSummary> => {
  const normalizedRootTaskIds = uniqueNonEmptyIds(rootTaskIds);
  if (normalizedRootTaskIds.length === 0) throw new Error("请选择需要删除的甘特任务");

  const [project, allTasks] = await Promise.all([
    client.project.findUnique({ where: { id: projectId }, select: { ganttRevision: true } }),
    client.projectGanttTask.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, parentId: true, taskCode: true, taskName: true },
    }),
  ]);
  if (!project) throw new Error("项目不存在");

  const validIds = new Set(allTasks.map((task) => task.id));
  if (normalizedRootTaskIds.some((taskId) => !validIds.has(taskId))) {
    throw new Error("待删除的甘特任务不存在或不属于当前项目");
  }

  const taskIds = ganttTaskSubtreeIds(allTasks, normalizedRootTaskIds);
  const taskIdSet = new Set(taskIds);
  const retainedTaskIds = allTasks.filter((task) => !taskIdSet.has(task.id)).map((task) => task.id);
  const [dependencies, weeklyTaskLinks, legacyWeeklyItems] = await Promise.all([
    client.projectGanttDependency.findMany({
      where: {
        projectId,
        OR: [
          { predecessorTaskId: { in: taskIds } },
          { successorTaskId: { in: taskIds } },
        ],
      },
      select: { predecessorTaskId: true, successorTaskId: true },
    }),
    client.weeklyItemGanttTask.findMany({
      where: { ganttTaskId: { in: taskIds }, weeklyItem: { projectId } },
      select: { weeklyItemId: true },
    }),
    client.weeklyItem.findMany({
      where: { projectId, ganttTaskId: { in: taskIds } },
      select: { id: true },
    }),
  ]);
  const affectedWeeklyItemIds = uniqueNonEmptyIds([
    ...weeklyTaskLinks.map((link) => link.weeklyItemId),
    ...legacyWeeklyItems.map((item) => item.id),
  ]);
  const affectedRisks = await client.riskRegisterItem.findMany({
    where: {
      projectId,
      OR: [
        { ganttTaskId: { in: taskIds } },
        ...(affectedWeeklyItemIds.length > 0 ? [
          { weeklyItemId: { in: affectedWeeklyItemIds } },
          { weeklyItemLinks: { some: { weeklyItemId: { in: affectedWeeklyItemIds } } } },
        ] : []),
      ],
    },
    select: { id: true },
  });
  const detachedWeeklyItemCount = affectedWeeklyItemIds.length;
  const affectedRiskCount = new Set(affectedRisks.map((risk) => risk.id)).size;
  const internalDependencyCount = dependencies.filter((dependency) => (
    taskIdSet.has(dependency.predecessorTaskId) && taskIdSet.has(dependency.successorTaskId)
  )).length;
  const successorTaskIds = [...new Set(dependencies
    .filter((dependency) => taskIdSet.has(dependency.predecessorTaskId) && retainedTaskIds.includes(dependency.successorTaskId))
    .map((dependency) => dependency.successorTaskId))];
  const rootTasks = allTasks
    .filter((task) => normalizedRootTaskIds.includes(task.id))
    .map((task) => ({ id: task.id, taskCode: task.taskCode, taskName: task.taskName }));

  return {
    rootTaskIds: normalizedRootTaskIds,
    rootTasks,
    taskIds,
    deletedTaskCount: taskIds.length,
    descendantTaskCount: Math.max(0, taskIds.length - normalizedRootTaskIds.length),
    dependencyCount: dependencies.length,
    internalDependencyCount,
    externalDependencyCount: dependencies.length - internalDependencyCount,
    detachedWeeklyItemCount,
    detachedRiskCount: affectedRiskCount,
    affectedRiskCount,
    clearedPredecessorCount: successorTaskIds.length,
    ganttRevision: project.ganttRevision,
  };
};

const buildGanttDeletionSnapshot = async (
  projectId: string,
  summary: GanttDeletionSummary,
  client: Prisma.TransactionClient,
): Promise<GanttDeletionSnapshot> => {
  const taskIds = summary.taskIds;
  const [tasks, dependencies, weeklyLinks, weeklyTaskLinks, riskLinks] = await Promise.all([
    client.projectGanttTask.findMany({
      where: { projectId, id: { in: taskIds } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: taskScalarSelect,
    }),
    client.projectGanttDependency.findMany({
      where: {
        projectId,
        OR: [
          { predecessorTaskId: { in: taskIds } },
          { successorTaskId: { in: taskIds } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: dependencyScalarSelect,
    }),
    client.weeklyItem.findMany({
      where: { projectId, ganttTaskId: { in: taskIds } },
      select: { id: true, ganttTaskId: true, taskName: true },
    }),
    client.weeklyItemGanttTask.findMany({
      where: { ganttTaskId: { in: taskIds }, weeklyItem: { projectId } },
      select: { weeklyItemId: true, ganttTaskId: true },
    }),
    client.riskRegisterItem.findMany({
      where: { projectId, ganttTaskId: { in: taskIds } },
      select: { id: true, ganttTaskId: true, linkedItemName: true },
    }),
  ]);
  return {
    version: 1,
    tasks,
    dependencies,
    weeklyLinks,
    weeklyTaskLinks,
    riskLinks,
    summary,
  };
};

export const previewGanttTaskDeletion = async (params: {
  projectId: string;
  rootTaskIds: string[];
}) => collectGanttDeletionSummary(params.projectId, params.rootTaskIds);

const deleteGanttTaskIds = async (params: {
  projectId: string;
  rootTaskIds: string[];
  taskIds: string[];
  operator: string;
  operatorUserId?: string;
  auditActionType: string;
  detailPrefix: string;
  expectedRevision?: number;
}) => {
  const requestedTaskIds = uniqueNonEmptyIds(params.taskIds);
  if (requestedTaskIds.length === 0) {
    return {
      deletedTaskCount: 0,
      detachedWeeklyItemCount: 0,
      detachedRiskCount: 0,
      affectedRiskCount: 0,
      clearedPredecessorCount: 0,
    };
  }

  const result = await prisma.$transaction(async (tx) => {
    const summary = await collectGanttDeletionSummary(params.projectId, params.rootTaskIds, tx);
    const requestedSet = new Set(requestedTaskIds);
    if (summary.taskIds.length !== requestedSet.size || summary.taskIds.some((taskId) => !requestedSet.has(taskId))) {
      throw new Error("删除范围已变化，请重新预览后再删除");
    }
    if (params.expectedRevision !== undefined && summary.ganttRevision !== params.expectedRevision) {
      throw new GanttRevisionConflictError();
    }

    const [project, snapshot] = await Promise.all([
      tx.project.findUniqueOrThrow({
        where: { id: params.projectId },
        select: { name: true, code: true, ganttRevision: true },
      }),
      buildGanttDeletionSnapshot(params.projectId, summary, tx),
    ]);
    const retainedTaskIds = (await tx.projectGanttTask.findMany({
      where: { projectId: params.projectId, id: { notIn: summary.taskIds } },
      select: { id: true },
    })).map((task) => task.id);
    const dependencyRows = await tx.projectGanttDependency.findMany({
      where: {
        projectId: params.projectId,
        predecessorTaskId: { in: summary.taskIds },
        successorTaskId: { in: retainedTaskIds },
      },
      select: { successorTaskId: true },
    });
    const successorTaskIds = [...new Set(dependencyRows.map((row) => row.successorTaskId))];
    const expiresAt = addDays(new Date(), GANTT_DELETION_RETENTION_DAYS);
    const batch = await tx.projectGanttDeletionBatch.create({
      data: {
        projectId: params.projectId,
        operatorUserId: params.operatorUserId ?? "",
        operatorName: params.operator,
        status: "AVAILABLE",
        rootTaskIds: JSON.stringify(summary.rootTaskIds),
        summary: JSON.stringify(summary),
        snapshotJson: JSON.stringify(snapshot),
        revisionBeforeDelete: project.ganttRevision,
        revisionAfterDelete: project.ganttRevision + 1,
        expiresAt,
      },
    });
    const affectedWeeklyItemIds = uniqueNonEmptyIds([
      ...(snapshot.weeklyTaskLinks ?? []).map((link) => link.weeklyItemId),
      ...snapshot.weeklyLinks.map((link) => link.id),
    ]);
    await tx.riskRegisterItem.updateMany({
      where: { projectId: params.projectId, ganttTaskId: { in: summary.taskIds } },
      data: { ganttTaskId: null, linkedItemName: "" },
    });
    if (successorTaskIds.length > 0) {
      await tx.projectGanttTask.updateMany({
        where: { id: { in: successorTaskIds }, projectId: params.projectId },
        data: { predecessorTask: "" },
      });
    }
    const deleted = await tx.projectGanttTask.deleteMany({ where: { id: { in: summary.taskIds }, projectId: params.projectId } });
    await synchronizeWeeklyItemLegacyTaskFields(tx, params.projectId, affectedWeeklyItemIds);
    await synchronizeGanttOwnerHierarchy({ tx, projectId: params.projectId });
    const changedProject = await tx.project.update({
      where: { id: params.projectId },
      data: { ganttRevision: { increment: 1 } },
      select: { ganttRevision: true },
    });
    if (changedProject.ganttRevision !== batch.revisionAfterDelete) {
      await tx.projectGanttDeletionBatch.update({
        where: { id: batch.id },
        data: { revisionAfterDelete: changedProject.ganttRevision },
      });
    }
    const detail = `${params.detailPrefix}，共 ${deleted.count} 条；更新 ${summary.detachedWeeklyItemCount} 条事项的任务关联、${summary.affectedRiskCount} 条风险的受影响任务范围，并清理紧前任务显示 ${successorTaskIds.length} 条。删除批次：${batch.id}。`;
    await Promise.all([
      tx.operationHistory.create({
        data: {
          projectId: params.projectId,
          entityType: "PROJECT_GANTT_TASK",
          entityId: batch.id,
          actionType: "DELETE",
          operator: params.operator,
          detail,
        },
      }),
      tx.adminAuditLog.create({
        data: {
          actionType: params.auditActionType,
          operator: params.operator,
          projectId: params.projectId,
          projectName: project.name || project.code,
          detail,
          snapshot: JSON.stringify({ deletionBatchId: batch.id, ...summary }),
        },
      }),
    ]);
    return {
      ...summary,
      deletionBatchId: batch.id,
      expiresAt: expiresAt.toISOString(),
      revisionAfterDelete: changedProject.ganttRevision,
      deletedTaskCount: deleted.count,
      detachedWeeklyItemCount: summary.detachedWeeklyItemCount,
      detachedRiskCount: summary.affectedRiskCount,
      affectedRiskCount: summary.affectedRiskCount,
      clearedPredecessorCount: successorTaskIds.length,
    };
  });
  await renumberProjectGanttTaskCodes(params.projectId);
  await recalculateProjectGanttSchedule(params.projectId);
  return result;
};

export const deleteGanttTaskSubtrees = async (params: {
  projectId: string;
  rootTaskIds: string[];
  operator: string;
  operatorUserId?: string;
  expectedRevision?: number;
}) => {
  const summary = await collectGanttDeletionSummary(params.projectId, params.rootTaskIds);
  return deleteGanttTaskIds({
    projectId: params.projectId,
    rootTaskIds: summary.rootTaskIds,
    taskIds: summary.taskIds,
    operator: params.operator,
    operatorUserId: params.operatorUserId,
    expectedRevision: params.expectedRevision,
    auditActionType: "DELETE_GANTT_TASK_SUBTREE",
    detailPrefix: `按用户指令删除 ${summary.deletedTaskCount} 条甘特任务（含所选任务的子任务）`,
  });
};

export const deleteGanttTasksAtOrBeyondDepth = async (params: {
  projectId: string;
  minimumDepth: number;
  operator: string;
}) => {
  const minimumDepth = Math.max(1, Math.floor(params.minimumDepth));
  const tasks = await prisma.projectGanttTask.findMany({
    where: { projectId: params.projectId },
    select: { id: true, parentId: true },
  });
  const taskIds = ganttTaskIdsAtOrBeyondDepth(tasks, minimumDepth);
  return deleteGanttTaskIds({
    projectId: params.projectId,
    rootTaskIds: taskIds,
    taskIds,
    operator: params.operator,
    auditActionType: "DELETE_GANTT_TASK_BY_DEPTH",
    detailPrefix: `按用户指令删除第 ${minimumDepth} 层及更深甘特任务，保留第 ${Math.max(0, minimumDepth - 1)} 层及更高层级任务`,
  });
};

const deletionBatchToDto = (batch: {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  projectId: string;
  operatorUserId: string;
  operatorName: string;
  status: string;
  rootTaskIds: string;
  summary: string;
  revisionBeforeDelete: number;
  revisionAfterDelete: number;
  expiresAt: Date;
  restoredAt: Date | null;
}) => ({
  ...batch,
  createdAt: batch.createdAt.toISOString(),
  updatedAt: batch.updatedAt.toISOString(),
  rootTaskIds: parseJson<string[]>(batch.rootTaskIds, []),
  summary: parseJson<GanttDeletionSummary | Record<string, never>>(batch.summary, {}),
  expiresAt: batch.expiresAt.toISOString(),
  restoredAt: batch.restoredAt?.toISOString() ?? null,
});

export const listGanttTaskDeletionBatches = async (projectId: string) => {
  const now = new Date();
  await prisma.projectGanttDeletionBatch.updateMany({
    where: { projectId, status: "AVAILABLE", expiresAt: { lt: now } },
    data: { status: "EXPIRED" },
  });
  const batches = await prisma.projectGanttDeletionBatch.findMany({
    where: { projectId, status: "AVAILABLE" },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return batches.map(deletionBatchToDto);
};

const taskDepthFromSnapshot = (task: Record<string, unknown>, byId: Map<string, Record<string, unknown>>) => {
  let depth = 0;
  let parentId = typeof task.parentId === "string" ? task.parentId : null;
  const seen = new Set<string>();
  while (parentId && byId.has(parentId) && !seen.has(parentId)) {
    seen.add(parentId);
    depth += 1;
    const parent = byId.get(parentId)!;
    parentId = typeof parent.parentId === "string" ? parent.parentId : null;
  }
  return depth;
};

export const restoreGanttTaskDeletionBatch = async (params: {
  projectId: string;
  batchId: string;
  operator: string;
  operatorUserId?: string;
}) => {
  const batch = await prisma.projectGanttDeletionBatch.findFirst({ where: { id: params.batchId, projectId: params.projectId } });
  if (!batch) throw new Error("删除批次不存在");
  if (batch.status === "RESTORED") {
    return { message: "该删除批次已恢复", restoredTaskCount: 0, warnings: [] as string[], batch: deletionBatchToDto(batch) };
  }
  if (batch.status !== "AVAILABLE" || batch.expiresAt < new Date()) {
    throw new Error("该删除批次已过期，无法恢复");
  }
  const snapshot = parseJson<GanttDeletionSnapshot | null>(batch.snapshotJson, null);
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.tasks)) {
    throw new Error("删除批次快照不可用，无法恢复");
  }

  const result = await prisma.$transaction(async (tx) => {
    const project = await tx.project.findUniqueOrThrow({
      where: { id: params.projectId },
      select: { name: true, code: true, ganttRevision: true },
    });
    const revisionChangedAfterDelete = project.ganttRevision !== batch.revisionAfterDelete;
    const taskIds = snapshot.tasks.map((task) => String(task.id || "")).filter(Boolean);
    const occupied = await tx.projectGanttTask.count({ where: { projectId: params.projectId, id: { in: taskIds } } });
    if (occupied > 0) throw new Error("部分待恢复任务 ID 已被占用，请刷新后重试");

    const ownerIds = [...new Set(snapshot.tasks.flatMap(ganttSnapshotOwnerMemberIds))];
    const budgetIds = [...new Set(snapshot.tasks.map((task) => typeof task.budgetItemId === "string" ? task.budgetItemId : "").filter(Boolean))];
    const [owners, budgetItems, retainedParentTasks] = await Promise.all([
      ownerIds.length ? tx.projectMember.findMany({ where: { projectId: params.projectId, id: { in: ownerIds } }, select: { id: true } }) : Promise.resolve([]),
      budgetIds.length ? tx.projectBudgetItem.findMany({ where: { projectId: params.projectId, id: { in: budgetIds } }, select: { id: true } }) : Promise.resolve([]),
      tx.projectGanttTask.findMany({ where: { projectId: params.projectId }, select: { id: true } }),
    ]);
    const validOwnerIds = new Set(owners.map((item) => item.id));
    const validBudgetIds = new Set(budgetItems.map((item) => item.id));
    const existingTaskIds = new Set(retainedParentTasks.map((item) => item.id));
    const snapshotTaskIds = new Set(taskIds);
    const taskById = new Map(snapshot.tasks.map((task) => [String(task.id), task]));
    const warnings: string[] = [];
    if (revisionChangedAfterDelete) {
      warnings.push("删除后甘特计划还执行过其他操作；本次仅恢复原删除范围，其他任务变更已保留");
    }

    const orderedTasks = [...snapshot.tasks].sort((left, right) => (
      taskDepthFromSnapshot(left, taskById) - taskDepthFromSnapshot(right, taskById)
      || Number(left.sortOrder ?? 0) - Number(right.sortOrder ?? 0)
    ));
    for (const rawTask of orderedTasks) {
      const snapshotOwnerIds = ganttSnapshotOwnerMemberIds(rawTask);
      const ownerMemberIds = snapshotOwnerIds.filter((ownerId) => validOwnerIds.has(ownerId));
      const ownerMemberId = ownerMemberIds.length === 1 ? ownerMemberIds[0] : null;
      if (snapshotOwnerIds.length > ownerMemberIds.length) warnings.push(`任务「${rawTask.taskName || rawTask.id}」的部分原负责人已不存在，已忽略失效负责人`);
      const budgetItemId = typeof rawTask.budgetItemId === "string" && validBudgetIds.has(rawTask.budgetItemId)
        ? rawTask.budgetItemId
        : null;
      if (rawTask.budgetItemId && !budgetItemId) warnings.push(`任务「${rawTask.taskName || rawTask.id}」的原预算条目已不存在，已恢复为空`);
      const rawParentId = typeof rawTask.parentId === "string" ? rawTask.parentId : null;
      const parentId = rawParentId && (snapshotTaskIds.has(rawParentId) || existingTaskIds.has(rawParentId)) ? rawParentId : null;
      if (rawParentId && !parentId) warnings.push(`任务「${rawTask.taskName || rawTask.id}」的原父任务已不存在，已恢复为一级任务`);

      await tx.projectGanttTask.create({
        data: {
          id: String(rawTask.id),
          createdAt: new Date(String(rawTask.createdAt)),
          updatedAt: new Date(String(rawTask.updatedAt)),
          projectId: params.projectId,
          parentId,
          ownerMemberId,
          taskCode: String(rawTask.taskCode ?? ""),
          taskCategory: String(rawTask.taskCategory ?? ""),
          taskName: String(rawTask.taskName ?? ""),
          taskDescription: String(rawTask.taskDescription ?? "").trim() || "无",
          startDate: String(rawTask.startDate ?? ""),
          finishDate: String(rawTask.finishDate ?? ""),
          durationDays: Number(rawTask.durationDays ?? 0),
          durationMinutes: Number(rawTask.durationMinutes ?? 0),
          durationFormat: Number(rawTask.durationFormat ?? 7),
          actualStartDate: String(rawTask.actualStartDate ?? ""),
          actualEndDate: String(rawTask.actualEndDate ?? ""),
          estimatedWorkHours: Number(rawTask.estimatedWorkHours ?? 0),
          actualWorkHours: Number(rawTask.actualWorkHours ?? 0),
          progress: Number(rawTask.progress ?? 0),
          predecessorTask: String(rawTask.predecessorTask ?? ""),
          taskMode: String(rawTask.taskMode ?? "AUTO"),
          isMilestone: Boolean(rawTask.isMilestone ?? false),
          externalUid: String(rawTask.externalUid ?? ""),
          wbsCode: String(rawTask.wbsCode ?? ""),
          outlineNumber: String(rawTask.outlineNumber ?? ""),
          calendarUid: String(rawTask.calendarUid ?? ""),
          constraintType: rawTask.constraintType === null || rawTask.constraintType === undefined ? null : Number(rawTask.constraintType),
          constraintDate: String(rawTask.constraintDate ?? ""),
          baselineStartDate: String(rawTask.baselineStartDate ?? ""),
          baselineFinishDate: String(rawTask.baselineFinishDate ?? ""),
          baselineCost: Number(rawTask.baselineCost ?? 0),
          budgetAtCompletion: Number(rawTask.budgetAtCompletion ?? 0),
          actualCost: Number(rawTask.actualCost ?? 0),
          budgetItemId,
          baselines: (rawTask.baselines ?? []) as Prisma.InputJsonValue,
          remark: String(rawTask.remark ?? ""),
          sortOrder: Number(rawTask.sortOrder ?? 0),
        },
      });
      existingTaskIds.add(String(rawTask.id));
    }

    const ownerLinkRows = ganttSnapshotOwnerLinkRows(snapshot.tasks, validOwnerIds);
    if (ownerLinkRows.length > 0) {
      await tx.projectGanttTaskOwner.createMany({ data: ownerLinkRows, skipDuplicates: true });
    }

    const restoredTaskIds = new Set([...existingTaskIds]);
    const dependencyRows = snapshot.dependencies
      .filter((dependency) => restoredTaskIds.has(String(dependency.predecessorTaskId)) && restoredTaskIds.has(String(dependency.successorTaskId)))
      .map((dependency) => ({
        id: String(dependency.id),
        createdAt: new Date(String(dependency.createdAt)),
        updatedAt: new Date(String(dependency.updatedAt)),
        projectId: params.projectId,
        predecessorTaskId: String(dependency.predecessorTaskId),
        successorTaskId: String(dependency.successorTaskId),
        type: Number(dependency.type ?? 1),
        lag: Number(dependency.lag ?? 0),
        lagFormat: Number(dependency.lagFormat ?? 7),
      }));
    const skippedDependencyCount = snapshot.dependencies.length - dependencyRows.length;
    if (skippedDependencyCount > 0) warnings.push(`${skippedDependencyCount} 条依赖因关联任务不存在而未恢复`);
    if (dependencyRows.length > 0) {
      await tx.projectGanttDependency.createMany({ data: dependencyRows, skipDuplicates: true });
    }

    const snapshotWeeklyTaskLinks = Array.isArray(snapshot.weeklyTaskLinks)
      ? snapshot.weeklyTaskLinks
      : (snapshot.weeklyLinks ?? []).flatMap((link) => (
        link.ganttTaskId ? [{ weeklyItemId: link.id, ganttTaskId: link.ganttTaskId }] : []
      ));
    const snapshotWeeklyItemIds = uniqueNonEmptyIds(snapshotWeeklyTaskLinks.map((link) => link.weeklyItemId));
    const existingWeeklyItems = snapshotWeeklyItemIds.length > 0
      ? await tx.weeklyItem.findMany({
        where: { projectId: params.projectId, id: { in: snapshotWeeklyItemIds } },
        select: { id: true },
      })
      : [];
    const existingWeeklyItemIds = new Set(existingWeeklyItems.map((item) => item.id));
    const restorableWeeklyTaskLinks = snapshotWeeklyTaskLinks.filter((link) => (
      existingWeeklyItemIds.has(link.weeklyItemId) && restoredTaskIds.has(link.ganttTaskId)
    ));
    const skippedWeeklyLinkCount = snapshotWeeklyTaskLinks.length - restorableWeeklyTaskLinks.length;
    if (skippedWeeklyLinkCount > 0) warnings.push(`${skippedWeeklyLinkCount} 条事项关联因事项或任务不存在而未恢复`);
    const restoredWeeklyLinks = restorableWeeklyTaskLinks.length > 0
      ? await tx.weeklyItemGanttTask.createMany({ data: restorableWeeklyTaskLinks, skipDuplicates: true })
      : { count: 0 };
    const restoredWeeklyLinkCount = restoredWeeklyLinks.count;
    await synchronizeWeeklyItemLegacyTaskFields(tx, params.projectId, snapshotWeeklyItemIds);

    const legacyRiskLinkCount = (snapshot.riskLinks ?? []).filter((link) => Boolean(link.ganttTaskId)).length;
    if (legacyRiskLinkCount > 0) {
      warnings.push(`检测到 ${legacyRiskLinkCount} 条旧版风险直接任务关联；风险现仅关联事项，因此未恢复这些直接关联`);
    }
    const restoredRiskLinkCount = 0;

    await synchronizeGanttOwnerHierarchy({ tx, projectId: params.projectId });

    const restoredAt = new Date();
    await tx.projectGanttDeletionBatch.update({
      where: { id: batch.id },
      data: { status: "RESTORED", restoredAt },
    });
    const changedProject = await tx.project.update({
      where: { id: params.projectId },
      data: { ganttRevision: { increment: 1 } },
      select: { ganttRevision: true },
    });
    const detail = `恢复删除批次 ${batch.id}：恢复 ${taskIds.length} 条甘特任务、${dependencyRows.length} 条依赖及 ${restoredWeeklyLinkCount} 条事项任务关联；风险受影响任务范围已通过关联事项自动恢复。`;
    await Promise.all([
      tx.operationHistory.create({
        data: {
          projectId: params.projectId,
          entityType: "PROJECT_GANTT_TASK",
          entityId: batch.id,
          actionType: "RESTORE",
          operator: params.operator,
          detail,
        },
      }),
      tx.adminAuditLog.create({
        data: {
          actionType: "RESTORE_GANTT_TASK_DELETION",
          operator: params.operator,
          projectId: params.projectId,
          projectName: project.name || project.code,
          detail,
          snapshot: JSON.stringify({ deletionBatchId: batch.id, restoredTaskCount: taskIds.length, restoredDependencyCount: dependencyRows.length, warnings }),
        },
      }),
    ]);
    return {
      message: `已恢复 ${taskIds.length} 条甘特任务`,
      restoredTaskCount: taskIds.length,
      restoredDependencyCount: dependencyRows.length,
      restoredWeeklyLinkCount,
      restoredRiskLinkCount,
      warnings,
      ganttRevision: changedProject.ganttRevision,
    };
  });

  await renumberProjectGanttTaskCodes(params.projectId);
  await recalculateProjectGanttSchedule(params.projectId);
  return result;
};

export const redoGanttTaskDeletionBatch = async (params: {
  projectId: string;
  batchId: string;
  operator: string;
  operatorUserId?: string;
}) => {
  const batch = await prisma.projectGanttDeletionBatch.findFirst({
    where: { id: params.batchId, projectId: params.projectId },
  });
  if (!batch) throw new Error("删除批次不存在");
  if (batch.status !== "RESTORED") {
    throw new Error("仅可取消刚完成的撤销操作");
  }

  const snapshot = parseJson<GanttDeletionSnapshot | null>(batch.snapshotJson, null);
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.tasks)) {
    throw new Error("删除批次快照不可用，无法取消撤销");
  }
  const taskIds = uniqueNonEmptyIds(snapshot.tasks.map((task) => String(task.id ?? "")));
  const rootTaskIds = uniqueNonEmptyIds(parseJson<string[]>(batch.rootTaskIds, []));
  if (taskIds.length === 0 || rootTaskIds.length === 0) {
    throw new Error("删除批次任务范围不可用，无法取消撤销");
  }

  return deleteGanttTaskIds({
    projectId: params.projectId,
    rootTaskIds,
    taskIds,
    operator: params.operator,
    operatorUserId: params.operatorUserId,
    auditActionType: "REDO_GANTT_TASK_DELETION",
    detailPrefix: `取消撤销删除批次 ${batch.id}`,
  });
};

export const changeProjectGanttTaskHierarchy = async (params: {
  projectId: string;
  taskIds: string[];
  direction: GanttHierarchyDirection;
  operator: string;
}) => {
  const tasks = await prisma.projectGanttTask.findMany({
    where: { projectId: params.projectId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, parentId: true, sortOrder: true, createdAt: true, taskCategory: true, taskName: true },
  });
  const validTaskIds = new Set(tasks.map((task) => task.id));
  if (params.taskIds.some((taskId) => !validTaskIds.has(taskId))) {
    throw new Error("所选任务不存在或不属于当前项目");
  }

  const changed = changeGanttTaskHierarchy(tasks, params.taskIds, params.direction);
  const synchronizedTasks = synchronizeGanttTaskCategories(changed.tasks, changed.changedTasks.map((task) => task.id));
  const originalById = new Map(tasks.map((task) => [task.id, task]));
  const updates = synchronizedTasks.filter((task) => {
    const original = originalById.get(task.id);
    return original && (
      (original.parentId ?? null) !== (task.parentId ?? null)
      || original.sortOrder !== task.sortOrder
      || original.taskCategory !== task.taskCategory
    );
  });
  const categoryUpdateCount = updates.filter((task) => originalById.get(task.id)?.taskCategory !== task.taskCategory).length;

  if (updates.length > 0) {
    await prisma.$transaction(async (tx) => {
      await Promise.all(updates.map((task) => tx.projectGanttTask.update({
        where: { id: task.id },
        data: {
          parentId: task.parentId ?? null,
          sortOrder: task.sortOrder,
          taskCategory: task.taskCategory,
        },
      })));
      await synchronizeGanttOwnerHierarchy({ tx, projectId: params.projectId });
      await Promise.all([
        tx.project.update({
          where: { id: params.projectId },
          data: { ganttRevision: { increment: 1 } },
        }),
        tx.operationHistory.create({
          data: {
            projectId: params.projectId,
            entityType: "PROJECT_GANTT_TASK",
            entityId: changed.movedTaskIds.join(","),
            actionType: "UPDATE",
            operator: params.operator,
            detail: `${params.direction === "INDENT" ? "下移" : "上移"} ${changed.movedTaskIds.length} 个任务层级，子任务随父任务联动${categoryUpdateCount > 0 ? `，同步 ${categoryUpdateCount} 条任务类别` : ""}`,
          },
        }),
      ]);
    });
    await renumberProjectGanttTaskCodes(params.projectId);
  }

  return {
    tasks: serializeGanttTaskList(await getOrderedGanttTasks(params.projectId)),
    movedTaskIds: changed.movedTaskIds,
  };
};

export type GanttInsertPlacement = "SIBLING_BEFORE" | "SIBLING_AFTER" | "CHILD_FIRST" | "CHILD_LAST";
export type GanttPastePosition = "BEFORE" | "AFTER";

const normalizeStructureTaskIds = (taskIds: string[]) => [...new Set(taskIds.map((id) => String(id || "").trim()).filter(Boolean))];

const selectedStructureRoots = (
  tasks: Array<{ id: string; parentId: string | null; sortOrder: number; createdAt?: Date | string }>,
  selectedTaskIds: string[],
) => {
  const selected = new Set(selectedTaskIds);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return orderGanttTasksByHierarchy(tasks).filter((task) => {
    if (!selected.has(task.id)) return false;
    let parentId = task.parentId;
    while (parentId) {
      if (selected.has(parentId)) return false;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return true;
  }).map((task) => task.id);
};

const cloneGanttTaskData = (
  task: Prisma.ProjectGanttTaskGetPayload<{ select: typeof taskScalarSelect }>,
  parentId: string | null,
  sortOrder: number,
): Prisma.ProjectGanttTaskUncheckedCreateInput => ({
  projectId: task.projectId,
  parentId,
  ownerMemberId: task.ownerMemberId,
  taskCode: "",
  taskCategory: task.taskCategory,
  taskName: task.taskName,
  taskDescription: task.taskDescription.trim() || "无",
  startDate: task.startDate,
  finishDate: task.finishDate,
  durationDays: task.durationDays,
  durationMinutes: task.durationMinutes,
  durationFormat: task.durationFormat,
  actualStartDate: task.actualStartDate,
  actualEndDate: task.actualEndDate,
  estimatedWorkHours: task.estimatedWorkHours,
  actualWorkHours: task.actualWorkHours,
  progress: task.progress,
  predecessorTask: "",
  taskMode: task.taskMode,
  isMilestone: task.isMilestone,
  externalUid: "",
  wbsCode: "",
  outlineNumber: "",
  calendarUid: task.calendarUid,
  constraintType: task.constraintType,
  constraintDate: task.constraintDate,
  resourceNotBeforeDate: task.resourceNotBeforeDate,
  baselineStartDate: task.baselineStartDate,
  baselineFinishDate: task.baselineFinishDate,
  baselineCost: task.baselineCost,
  budgetAtCompletion: task.budgetAtCompletion,
  actualCost: task.actualCost,
  budgetItemId: task.budgetItemId,
  baselines: task.baselines as Prisma.InputJsonValue,
  remark: task.remark,
  sortOrder,
});

export const insertProjectGanttTasks = async (params: {
  projectId: string;
  anchorTaskId: string;
  placement: GanttInsertPlacement;
  count: number;
  operator: string;
}) => {
  const count = Math.max(1, Math.min(100, Math.floor(params.count)));
  const createdTaskIds = await prisma.$transaction(async (tx) => {
    const anchor = await tx.projectGanttTask.findFirst({ where: { id: params.anchorTaskId, projectId: params.projectId } });
    if (!anchor) throw new Error("插入位置对应的任务不存在");
    const childPlacement = params.placement === "CHILD_FIRST" || params.placement === "CHILD_LAST";
    const parentId = childPlacement ? anchor.id : anchor.parentId;
    const inheritedOwnerMemberId = parentId
      ? await resolveEffectiveGanttOwnerMemberId({ tx, projectId: params.projectId, taskId: parentId })
      : null;
    const siblings = await tx.projectGanttTask.findMany({
      where: { projectId: params.projectId, parentId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, sortOrder: true },
    });
    const anchorIndex = childPlacement ? -1 : siblings.findIndex((task) => task.id === anchor.id);
    const insertIndex = params.placement === "SIBLING_BEFORE"
      ? Math.max(0, anchorIndex)
      : params.placement === "SIBLING_AFTER"
        ? Math.max(0, anchorIndex + 1)
        : params.placement === "CHILD_FIRST"
          ? 0
          : siblings.length;
    const createdTasks = await tx.projectGanttTask.createManyAndReturn({
      data: Array.from({ length: count }, (_, index) => ({
          projectId: params.projectId,
          parentId,
          ownerMemberId: inheritedOwnerMemberId,
          taskCode: "",
          taskCategory: anchor.taskCategory,
          taskName: "",
          taskDescription: "无",
          startDate: "",
          finishDate: "",
          durationDays: 0,
          durationMinutes: 0,
          estimatedWorkHours: 0,
          actualWorkHours: 0,
          progress: 0,
          predecessorTask: "",
          remark: "",
          sortOrder: insertIndex + index + 1,
      })),
      select: { id: true, sortOrder: true },
    });
    const ids = createdTasks
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((task) => task.id);
    const orderedSiblingIds = siblings.map((task) => task.id);
    orderedSiblingIds.splice(insertIndex, 0, ...ids);
    await bulkUpdateGanttSortOrders(tx, orderedSiblingIds.map((taskId, index) => ({ id: taskId, sortOrder: index + 1 })));
    await synchronizeGanttOwnerHierarchy({ tx, projectId: params.projectId });
    await Promise.all([
      tx.project.update({ where: { id: params.projectId }, data: { ganttRevision: { increment: 1 } } }),
      tx.operationHistory.create({
        data: {
          projectId: params.projectId,
          entityType: "PROJECT_GANTT_TASK",
          entityId: ids.join(","),
          actionType: "CREATE",
          operator: params.operator,
          detail: `在任务 ${anchor.taskCode || anchor.taskName || anchor.id} ${params.placement.includes("BEFORE") || params.placement === "CHILD_FIRST" ? "上方" : "下方"}批量插入 ${count} 条${childPlacement ? "子任务" : "同级任务"}`,
        },
      }),
    ]);
    return ids;
  }, { timeout: 30_000, maxWait: 10_000 });
  await renumberProjectGanttTaskCodes(params.projectId);
  return { tasks: serializeGanttTaskList(await getOrderedGanttTasks(params.projectId)), createdTaskIds };
};

export const copyProjectGanttTasks = async (params: {
  projectId: string;
  sourceTaskIds: string[];
  anchorTaskId: string;
  position: GanttPastePosition;
  operator: string;
}) => {
  const sourceTaskIds = normalizeStructureTaskIds(params.sourceTaskIds);
  if (sourceTaskIds.length === 0) throw new Error("请先复制需要粘贴的任务");
  const createdTaskIds = await prisma.$transaction(async (tx) => {
    const [anchor, allTasks, selectedTasks, dependencies] = await Promise.all([
      tx.projectGanttTask.findFirst({ where: { id: params.anchorTaskId, projectId: params.projectId } }),
      tx.projectGanttTask.findMany({ where: { projectId: params.projectId }, select: { id: true, parentId: true, sortOrder: true, createdAt: true } }),
      tx.projectGanttTask.findMany({ where: { projectId: params.projectId, id: { in: sourceTaskIds } }, select: taskScalarSelect }),
      tx.projectGanttDependency.findMany({ where: { projectId: params.projectId, successorTaskId: { in: sourceTaskIds } }, select: dependencyScalarSelect }),
    ]);
    if (!anchor) throw new Error("粘贴位置对应的任务不存在");
    if (selectedTasks.length !== sourceTaskIds.length) throw new Error("部分待复制任务不存在");
    const selectedSet = new Set(sourceTaskIds);
    const sourceById = new Map(selectedTasks.map((task) => [task.id, task]));
    const orderedSource = orderGanttTasksByHierarchy(allTasks).filter((task) => selectedSet.has(task.id)).map((task) => sourceById.get(task.id)!);
    const roots = selectedStructureRoots(allTasks, sourceTaskIds);
    const rootSet = new Set(roots);
    const targetParentId = anchor.parentId;
    const targetSiblings = orderGanttTasksByHierarchy(allTasks).filter((task) => (task.parentId ?? null) === (targetParentId ?? null)).map((task) => task.id);
    const targetIndex = targetSiblings.indexOf(anchor.id);
    const insertIndex = params.position === "BEFORE" ? targetIndex : targetIndex + 1;
    const newIdByOldId = new Map<string, string>();
    const rootIds: string[] = [];
    const childCursor = new Map<string, number>();
    for (const source of orderedSource) {
      const copiedParentId = source.parentId && selectedSet.has(source.parentId) ? newIdByOldId.get(source.parentId) ?? null : targetParentId;
      const rootIndex = rootSet.has(source.id) ? rootIds.length : 0;
      const nextChildOrder = copiedParentId && !rootSet.has(source.id) ? (childCursor.get(copiedParentId) ?? 0) + 1 : 0;
      if (copiedParentId && !rootSet.has(source.id)) childCursor.set(copiedParentId, nextChildOrder);
      const created = await tx.projectGanttTask.create({
        data: cloneGanttTaskData(source, copiedParentId, rootSet.has(source.id) ? insertIndex + rootIndex + 1 : nextChildOrder),
      });
      const copiedOwnerMemberIds = ganttSnapshotOwnerMemberIds(source as unknown as Record<string, unknown>);
      if (copiedOwnerMemberIds.length > 0) {
        await tx.projectGanttTaskOwner.createMany({
          data: copiedOwnerMemberIds.map((projectMemberId) => ({ taskId: created.id, projectMemberId })),
          skipDuplicates: true,
        });
      }
      newIdByOldId.set(source.id, created.id);
      if (rootSet.has(source.id)) rootIds.push(created.id);
    }
    targetSiblings.splice(insertIndex, 0, ...rootIds);
    await bulkUpdateGanttSortOrders(tx, targetSiblings.map((taskId, index) => ({ id: taskId, sortOrder: index + 1 })));
    const dependencyRows = dependencies.map((dependency) => ({
      projectId: params.projectId,
      predecessorTaskId: newIdByOldId.get(dependency.predecessorTaskId) ?? dependency.predecessorTaskId,
      successorTaskId: newIdByOldId.get(dependency.successorTaskId)!,
      type: dependency.type,
      lag: dependency.lag,
      lagFormat: dependency.lagFormat,
    })).filter((dependency) => dependency.successorTaskId && dependency.predecessorTaskId !== dependency.successorTaskId);
    if (dependencyRows.length > 0) await tx.projectGanttDependency.createMany({ data: dependencyRows, skipDuplicates: true });
    const ids = orderedSource.map((task) => newIdByOldId.get(task.id)!).filter(Boolean);
    await synchronizeGanttOwnerHierarchy({ tx, projectId: params.projectId });
    await Promise.all([
      tx.project.update({ where: { id: params.projectId }, data: { ganttRevision: { increment: 1 } } }),
      tx.operationHistory.create({
        data: { projectId: params.projectId, entityType: "PROJECT_GANTT_TASK", entityId: ids.join(","), actionType: "CREATE", operator: params.operator, detail: `复制并粘贴 ${ids.length} 条甘特任务` },
      }),
    ]);
    return ids;
  }, { timeout: 30_000, maxWait: 10_000 });
  await renumberProjectGanttTaskCodes(params.projectId);
  await recalculateProjectGanttSchedule(params.projectId);
  return { tasks: serializeGanttTaskList(await getOrderedGanttTasks(params.projectId)), createdTaskIds };
};

export const moveProjectGanttTaskBranches = async (params: {
  projectId: string;
  sourceTaskIds: string[];
  anchorTaskId: string;
  position: GanttPastePosition;
  operator: string;
}) => {
  const sourceTaskIds = normalizeStructureTaskIds(params.sourceTaskIds);
  if (sourceTaskIds.length === 0) throw new Error("请先剪切需要移动的任务");
  const movedTaskIds = await prisma.$transaction(async (tx) => {
    const tasks = await tx.projectGanttTask.findMany({
      where: { projectId: params.projectId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, parentId: true, sortOrder: true, createdAt: true, taskCategory: true, taskName: true },
    });
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const anchor = taskById.get(params.anchorTaskId);
    if (!anchor) throw new Error("粘贴位置对应的任务不存在");
    const roots = selectedStructureRoots(tasks, sourceTaskIds);
    if (roots.length === 0) throw new Error("待移动任务不存在");
    const childIds = new Map<string, string[]>();
    tasks.forEach((task) => task.parentId && childIds.set(task.parentId, [...(childIds.get(task.parentId) ?? []), task.id]));
    const movedSet = new Set<string>();
    const collect = (taskId: string) => {
      if (movedSet.has(taskId)) return;
      movedSet.add(taskId);
      (childIds.get(taskId) ?? []).forEach(collect);
    };
    roots.forEach(collect);
    if (movedSet.has(anchor.id)) throw new Error("不能将剪切任务粘贴到自身或其子任务附近");

    const updated = new Map(tasks.map((task) => [task.id, { ...task }]));
    const targetParentId = anchor.parentId;
    const affectedParentIds = new Set<string | null>([targetParentId]);
    roots.forEach((rootId) => affectedParentIds.add(updated.get(rootId)?.parentId ?? null));
    const rootSet = new Set(roots);
    const rootsInOrder = orderGanttTasksByHierarchy(tasks).filter((task) => rootSet.has(task.id)).map((task) => task.id);
    for (const parentId of affectedParentIds) {
      const siblings = orderGanttTasksByHierarchy(tasks)
        .filter((task) => (task.parentId ?? null) === (parentId ?? null) && !rootSet.has(task.id))
        .map((task) => task.id);
      if ((parentId ?? null) === (targetParentId ?? null)) {
        const anchorIndex = siblings.indexOf(anchor.id);
        const insertIndex = params.position === "BEFORE" ? anchorIndex : anchorIndex + 1;
        siblings.splice(insertIndex, 0, ...rootsInOrder);
      }
      siblings.forEach((taskId, index) => {
        const task = updated.get(taskId);
        if (task) updated.set(taskId, { ...task, parentId, sortOrder: index + 1 });
      });
    }
    const synchronized = synchronizeGanttTaskCategories([...updated.values()], rootsInOrder);
    const originalById = new Map(tasks.map((task) => [task.id, task]));
    const changes = synchronized.filter((task) => {
      const original = originalById.get(task.id)!;
      return (original.parentId ?? null) !== (task.parentId ?? null) || original.sortOrder !== task.sortOrder || original.taskCategory !== task.taskCategory;
    });
    await bulkUpdateGanttStructure(tx, changes.map((task) => ({
      id: task.id,
      parentId: task.parentId ?? null,
      sortOrder: task.sortOrder,
      taskCategory: task.taskCategory,
    })));
    await synchronizeGanttOwnerHierarchy({ tx, projectId: params.projectId });
    await Promise.all([
      tx.project.update({ where: { id: params.projectId }, data: { ganttRevision: { increment: 1 } } }),
      tx.operationHistory.create({
        data: { projectId: params.projectId, entityType: "PROJECT_GANTT_TASK", entityId: rootsInOrder.join(","), actionType: "UPDATE", operator: params.operator, detail: `剪切并移动 ${movedSet.size} 条甘特任务` },
      }),
    ]);
    return [...movedSet];
  }, { timeout: 30_000, maxWait: 10_000 });
  await renumberProjectGanttTaskCodes(params.projectId);
  return { tasks: serializeGanttTaskList(await getOrderedGanttTasks(params.projectId)), movedTaskIds };
};
