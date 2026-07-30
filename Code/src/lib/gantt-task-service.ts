import type { Prisma } from "@prisma/client";

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
import { scheduleGanttTasks } from "@/lib/gantt-schedule";

const ganttTaskInclude = {
  ownerMember: {
    select: { id: true, personName: true, roleName: true },
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

export const serializeGanttTask = (task: GanttTaskRecord) => {
  const predecessorTaskIds = task.predecessorDependencies.map((dependency) => dependency.predecessorTaskId);
  const predecessorNames = task.predecessorDependencies
    .map((dependency) => dependency.predecessorTask.taskName)
    .filter(Boolean);

  return {
    ...task,
    predecessorTaskIds,
    predecessorTask: predecessorNames.length > 0 ? predecessorNames.join(",") : task.predecessorTask,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    predecessorDependencies: task.predecessorDependencies.map((dependency) => ({
      ...dependency,
      createdAt: dependency.createdAt.toISOString(),
      updatedAt: dependency.updatedAt.toISOString(),
    })),
  };
};

export const getOrderedGanttTasks = async (projectId: string) => {
  const tasks = await prisma.projectGanttTask.findMany({
    where: { projectId },
    orderBy: [{ sortOrder: "asc" }, { startDate: "asc" }, { createdAt: "asc" }],
    include: ganttTaskInclude,
  });
  const normalizedTasks = assignMissingGanttTaskCodes(tasks);
  const taskCodeUpdates = normalizedTasks.filter((task) => {
    const original = tasks.find((item) => item.id === task.id);
    return original && original.taskCode !== task.taskCode;
  });

  if (taskCodeUpdates.length > 0) {
    await prisma.$transaction(
      taskCodeUpdates.map((task) => (
        prisma.projectGanttTask.update({
          where: { id: task.id },
          data: { taskCode: task.taskCode },
        })
      ))
    );
  }

  return orderGanttTasksByHierarchy(normalizedTasks);
};

export const getProjectGanttCalendarMode = async (projectId: string): Promise<GanttCalendarMode> => {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { ganttCalendarMode: true },
  });
  return normalizeGanttCalendarMode(project?.ganttCalendarMode);
};

export const recalculateProjectGanttSchedule = async (
  projectId: string,
  requestedMode?: GanttCalendarMode,
) => {
  const mode = requestedMode ?? await getProjectGanttCalendarMode(projectId);
  const tasks = await prisma.projectGanttTask.findMany({
    where: { projectId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    include: {
      predecessorDependencies: {
        select: { predecessorTaskId: true, type: true, lag: true },
      },
    },
  });
  const scheduled = scheduleGanttTasks(tasks, mode);
  const currentById = new Map(tasks.map((task) => [task.id, task]));
  const updates = scheduled.filter((task) => {
    const current = currentById.get(task.id)!;
    return current.startDate !== task.startDate
      || current.finishDate !== task.finishDate
      || current.durationDays !== task.durationDays
      || current.durationMinutes !== task.durationMinutes
      || Math.abs(current.estimatedWorkHours - task.estimatedWorkHours) > 0.001;
  });

  if (updates.length > 0) {
    await prisma.$transaction(updates.map((task) => prisma.projectGanttTask.update({
      where: { id: task.id },
      data: {
        startDate: task.startDate,
        finishDate: task.finishDate,
        durationDays: task.durationDays,
        durationMinutes: task.durationMinutes,
        estimatedWorkHours: task.estimatedWorkHours,
      },
    })));
  }
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

export const renumberProjectGanttTaskCodes = async (projectId: string) => {
  const tasks = await prisma.projectGanttTask.findMany({
    where: { projectId },
    orderBy: [{ sortOrder: "asc" }, { startDate: "asc" }, { createdAt: "asc" }],
  });
  const renumberedTasks = renumberGanttTaskCodes(tasks);
  const updates = renumberedTasks.filter((task) => {
    const original = tasks.find((item) => item.id === task.id);
    return original && original.taskCode !== task.taskCode;
  });

  if (updates.length === 0) return;

  await prisma.$transaction(
    updates.map((task) => (
      prisma.projectGanttTask.update({
        where: { id: task.id },
        data: { taskCode: task.taskCode },
      })
    ))
  );
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
  clearedPredecessorCount: number;
  ganttRevision: number;
};

type GanttDeletionSnapshot = {
  version: 1;
  tasks: Array<Record<string, unknown>>;
  dependencies: Array<Record<string, unknown>>;
  weeklyLinks: Array<{ id: string; ganttTaskId: string | null; taskName: string }>;
  riskLinks: Array<{ id: string; ganttTaskId: string | null; linkedItemName: string }>;
  summary: GanttDeletionSummary;
};

const taskScalarSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  projectId: true,
  parentId: true,
  ownerMemberId: true,
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
  const [dependencies, detachedWeeklyItemCount, detachedRiskCount] = await Promise.all([
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
    client.weeklyItem.count({ where: { projectId, ganttTaskId: { in: taskIds } } }),
    client.riskRegisterItem.count({ where: { projectId, ganttTaskId: { in: taskIds } } }),
  ]);
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
    detachedRiskCount,
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
  const [tasks, dependencies, weeklyLinks, riskLinks] = await Promise.all([
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
    return { deletedTaskCount: 0, detachedWeeklyItemCount: 0, detachedRiskCount: 0, clearedPredecessorCount: 0 };
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
    const [weeklyItems, riskItems] = await Promise.all([
      tx.weeklyItem.updateMany({
        where: { projectId: params.projectId, ganttTaskId: { in: summary.taskIds } },
        data: { ganttTaskId: null, taskName: "" },
      }),
      tx.riskRegisterItem.updateMany({
        where: { projectId: params.projectId, ganttTaskId: { in: summary.taskIds } },
        data: { ganttTaskId: null, linkedItemName: "" },
      }),
    ]);
    if (successorTaskIds.length > 0) {
      await tx.projectGanttTask.updateMany({
        where: { id: { in: successorTaskIds }, projectId: params.projectId },
        data: { predecessorTask: "" },
      });
    }
    const deleted = await tx.projectGanttTask.deleteMany({ where: { id: { in: summary.taskIds }, projectId: params.projectId } });
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
    const detail = `${params.detailPrefix}，共 ${deleted.count} 条；解除事项关联 ${weeklyItems.count} 条、风险关联 ${riskItems.count} 条，并清理紧前任务显示 ${successorTaskIds.length} 条。删除批次：${batch.id}。`;
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
      detachedWeeklyItemCount: weeklyItems.count,
      detachedRiskCount: riskItems.count,
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
    if (project.ganttRevision !== batch.revisionAfterDelete) {
      throw new GanttRevisionConflictError("删除后甘特计划已发生变化，请先确认近期变更后再恢复");
    }
    const taskIds = snapshot.tasks.map((task) => String(task.id || "")).filter(Boolean);
    const occupied = await tx.projectGanttTask.count({ where: { projectId: params.projectId, id: { in: taskIds } } });
    if (occupied > 0) throw new Error("部分待恢复任务 ID 已被占用，请刷新后重试");

    const ownerIds = [...new Set(snapshot.tasks.map((task) => typeof task.ownerMemberId === "string" ? task.ownerMemberId : "").filter(Boolean))];
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

    const orderedTasks = [...snapshot.tasks].sort((left, right) => (
      taskDepthFromSnapshot(left, taskById) - taskDepthFromSnapshot(right, taskById)
      || Number(left.sortOrder ?? 0) - Number(right.sortOrder ?? 0)
    ));
    for (const rawTask of orderedTasks) {
      const ownerMemberId = typeof rawTask.ownerMemberId === "string" && validOwnerIds.has(rawTask.ownerMemberId)
        ? rawTask.ownerMemberId
        : null;
      if (rawTask.ownerMemberId && !ownerMemberId) warnings.push(`任务「${rawTask.taskName || rawTask.id}」的原负责人已不存在，已恢复为空`);
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
          taskDescription: String(rawTask.taskDescription ?? ""),
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
    if (dependencyRows.length > 0) {
      await tx.projectGanttDependency.createMany({ data: dependencyRows, skipDuplicates: true });
    }

    let restoredWeeklyLinkCount = 0;
    for (const link of snapshot.weeklyLinks ?? []) {
      const updated = await tx.weeklyItem.updateMany({
        where: { id: link.id, projectId: params.projectId, ganttTaskId: null },
        data: { ganttTaskId: link.ganttTaskId, taskName: link.taskName },
      });
      restoredWeeklyLinkCount += updated.count;
    }
    let restoredRiskLinkCount = 0;
    for (const link of snapshot.riskLinks ?? []) {
      const updated = await tx.riskRegisterItem.updateMany({
        where: { id: link.id, projectId: params.projectId, ganttTaskId: null },
        data: { ganttTaskId: link.ganttTaskId, linkedItemName: link.linkedItemName },
      });
      restoredRiskLinkCount += updated.count;
    }

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
    const detail = `恢复删除批次 ${batch.id}：恢复 ${taskIds.length} 条甘特任务、${dependencyRows.length} 条依赖、${restoredWeeklyLinkCount} 条事项关联、${restoredRiskLinkCount} 条风险关联。`;
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
    expectedRevision: batch.revisionAfterDelete + 1,
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
  const synchronizedTasks = synchronizeGanttTaskCategories(changed.tasks, changed.movedTaskIds);
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
    await prisma.$transaction([
      ...updates.map((task) => prisma.projectGanttTask.update({
        where: { id: task.id },
        data: {
          parentId: task.parentId ?? null,
          sortOrder: task.sortOrder,
          taskCategory: task.taskCategory,
        },
      })),
      prisma.operationHistory.create({
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
    await renumberProjectGanttTaskCodes(params.projectId);
  }

  return {
    tasks: (await getOrderedGanttTasks(params.projectId)).map(serializeGanttTask),
    movedTaskIds: changed.movedTaskIds,
  };
};
