import { prisma } from "@/lib/prisma";
import {
  createResourceScheduleCandidates,
  detectResourceConflicts,
  detectResourceScheduleIssues,
  resourceScheduleSnapshotHash,
  type ResourceConflict,
  type ResourceScheduleCandidate,
  type ResourceScheduleCandidateKind,
  type ResourceScheduleModeOverride,
  type ResourceSchedulingTask,
} from "@/lib/gantt-resource-schedule";
import { recalculateProjectGanttSchedule } from "@/lib/gantt-task-service";

export const RESOURCE_SCHEDULE_CANDIDATE_KINDS: readonly ResourceScheduleCandidateKind[] = [
  "MINIMAL_CHANGE",
  "EARLIEST_FINISH",
  "ON_TIME",
  "RESOURCE_SMOOTHING",
];

export interface ResourceTaskSummary {
  id: string;
  projectId: string;
  projectName: string;
  taskCode: string;
  taskName: string;
  startDate: string;
  finishDate: string;
  isCurrentProject: boolean;
}

export interface ProjectResourceScheduleContext {
  currentProject: {
    id: string;
    name: string;
    expectedEndDate: string;
    ganttHardFinishDate: string;
    ganttCalendarMode: string;
    ganttRevision: number;
    status: string;
  };
  tasks: ResourceSchedulingTask[];
  summaries: ResourceTaskSummary[];
}

export interface ProjectResourceScheduleScope {
  /** Parent tasks selected by the user; empty means the whole current project. */
  rootTaskIds: string[];
  /** Eligible leaf tasks expanded from the selected parent roots. */
  taskIds: string[];
  modeOverride: ResourceScheduleModeOverride;
}

export interface ProjectManualScheduleImpact {
  requiresConfirmation: boolean;
  affectedTaskIds: string[];
  affectedTasks: ResourceTaskSummary[];
  issues: ReturnType<typeof detectResourceScheduleIssues>;
  conflicts: ResourceConflict[];
}

/**
 * A manual-edit preview must use the proposed dependency graph, not the graph
 * currently stored in the database. Otherwise adding a predecessor appears to
 * affect no upstream work, while removing one hides the released constraint.
 */
export type ManualSchedulePreviewPatch = Pick<
  ResourceSchedulingTask,
  "startDate" | "finishDate" | "durationDays" | "taskMode"
> & Partial<Pick<
  ResourceSchedulingTask,
  "predecessorDependencies"
  | "ownerAssignments"
  | "parentBoundaryMode"
  | "schedulePriority"
  | "effortDriven"
  | "parallelizable"
>>;

export const collectManualScheduleImpactTaskIds = (
  tasks: ResourceSchedulingTask[],
  taskId: string,
  patch: ManualSchedulePreviewPatch,
) => {
  const target = tasks.find((task) => task.id === taskId);
  if (!target) throw new Error("甘特任务不存在");

  const patchedTasks = tasks.map((task) => {
    if (task.id !== taskId) return task;
    const ownerAssignments = patch.ownerAssignments === undefined
      ? task.ownerAssignments
      : patch.ownerAssignments;
    return {
      ...task,
      ...patch,
      ownerAssignments,
      ownerKeys: ownerAssignments === undefined
        ? task.ownerKeys
        : [...new Set(ownerAssignments.map((assignment) => assignment.ownerKey).filter(Boolean))],
    };
  });
  const patchedTarget = patchedTasks.find((task) => task.id === taskId)!;
  const directlyRelatedIds = new Set([
    taskId,
    ...target.predecessorDependencies.map((dependency) => dependency.predecessorTaskId),
    ...patchedTarget.predecessorDependencies.map((dependency) => dependency.predecessorTaskId),
  ]);
  const taskIds = new Set(patchedTasks.map((task) => task.id));
  const successors = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  patchedTasks.forEach((task) => task.predecessorDependencies.forEach((dependency) => {
    if (!taskIds.has(dependency.predecessorTaskId)) return;
    successors.set(dependency.predecessorTaskId, [
      ...(successors.get(dependency.predecessorTaskId) ?? []),
      task.id,
    ]);
  }));
  patchedTasks.forEach((task) => {
    if (!task.parentId || !taskIds.has(task.parentId)) return;
    children.set(task.parentId, [...(children.get(task.parentId) ?? []), task.id]);
  });

  const affectedTaskIds = new Set<string>([...directlyRelatedIds].filter((id) => taskIds.has(id)));
  let ancestorId = target.parentId ?? null;
  const ancestorGuard = new Set<string>();
  while (ancestorId && taskIds.has(ancestorId) && !ancestorGuard.has(ancestorId)) {
    ancestorGuard.add(ancestorId);
    affectedTaskIds.add(ancestorId);
    ancestorId = patchedTasks.find((task) => task.id === ancestorId)?.parentId ?? null;
  }
  const queue = [...affectedTaskIds];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    [
      ...(successors.get(currentId) ?? []),
      ...(children.get(currentId) ?? []),
    ].forEach((affectedId) => {
      if (affectedTaskIds.has(affectedId)) return;
      affectedTaskIds.add(affectedId);
      queue.push(affectedId);
    });
  }

  return {
    patchedTasks,
    affectedTaskIds: tasks
      .filter((task) => affectedTaskIds.has(task.id))
      .map((task) => task.id),
  };
};

export const loadProjectResourceScheduleContext = async (projectId: string): Promise<ProjectResourceScheduleContext> => {
  const projects = await prisma.project.findMany({
    where: { status: { not: "VOIDED" } },
    select: { id: true, name: true, expectedEndDate: true, ganttHardFinishDate: true, ganttCalendarMode: true, ganttRevision: true, status: true },
  });
  const currentProject = projects.find((project) => project.id === projectId);
  if (!currentProject) throw new Error("项目不存在");
  const tasks = await prisma.projectGanttTask.findMany({
    where: { projectId: { in: projects.map((project) => project.id) } },
    orderBy: [{ projectId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    include: {
      ownerMember: {
        select: {
          id: true,
          accountId: true,
          personName: true,
          capacityHoursPerDay: true,
          productivityRate: true,
          maxConcurrentAssignments: true,
        },
      },
      ownerLinks: {
        orderBy: { createdAt: "asc" },
        include: {
          projectMember: {
            select: {
              id: true,
              accountId: true,
              personName: true,
              capacityHoursPerDay: true,
              productivityRate: true,
              maxConcurrentAssignments: true,
            },
          },
        },
      },
      predecessorDependencies: {
        select: { predecessorTaskId: true, type: true, lag: true, lagFormat: true },
      },
    },
  });
  const parentIdsByProject = new Map<string, Set<string>>();
  tasks.forEach((task) => {
    if (!task.parentId) return;
    const ids = parentIdsByProject.get(task.projectId) ?? new Set<string>();
    ids.add(task.parentId);
    parentIdsByProject.set(task.projectId, ids);
  });
  const projectById = new Map(projects.map((project) => [project.id, project] as const));
  const summaries = tasks.map((task) => ({
    id: task.id,
    projectId: task.projectId,
    projectName: projectById.get(task.projectId)?.name ?? "",
    taskCode: task.taskCode,
    taskName: task.taskName,
    startDate: task.startDate,
    finishDate: task.finishDate,
    isCurrentProject: task.projectId === projectId,
  }));
  const resourceTasks: ResourceSchedulingTask[] = tasks.map((task) => {
    const assignments = task.ownerLinks.length > 0
      ? task.ownerLinks.map((link) => ({
        owner: link.projectMember,
        unitsPercent: link.unitsPercent,
        plannedWorkHours: link.plannedWorkHours,
      }))
      : task.ownerMember ? [{
        owner: task.ownerMember,
        unitsPercent: 100,
        plannedWorkHours: 0,
      }] : [];
    const ownerAssignments = assignments.map(({ owner, unitsPercent, plannedWorkHours }) => ({
      ownerKey: owner.accountId ? `account:${owner.accountId}` : `person:${owner.personName}`,
      unitsPercent,
      plannedWorkHours,
      capacityHoursPerDay: owner.capacityHoursPerDay,
      productivityRate: owner.productivityRate,
      maxConcurrentAssignments: owner.maxConcurrentAssignments,
    }));
    return {
      id: task.id,
      projectId: task.projectId,
      projectName: projectById.get(task.projectId)?.name,
      taskName: task.taskName,
      parentId: task.parentId,
      isLeaf: !(parentIdsByProject.get(task.projectId)?.has(task.id) ?? false),
      ownerKeys: [...new Set(ownerAssignments.map((assignment) => assignment.ownerKey))],
      ownerAssignments,
      startDate: task.startDate,
      finishDate: task.finishDate,
      durationDays: task.durationDays,
      durationMinutes: task.durationMinutes,
      estimatedWorkHours: task.estimatedWorkHours,
      progress: task.progress,
      taskMode: task.taskMode,
      parentBoundaryMode: task.parentBoundaryMode,
      schedulePriority: task.schedulePriority,
      effortDriven: task.effortDriven,
      parallelizable: task.parallelizable,
      resourceNotBeforeDate: task.resourceNotBeforeDate,
      earlyStartDate: task.earlyStartDate,
      lateStartDate: task.lateStartDate,
      lateFinishDate: task.lateFinishDate,
      totalFloatMinutes: task.totalFloatMinutes,
      sortOrder: task.sortOrder,
      predecessorDependencies: task.predecessorDependencies,
      isCurrentProject: task.projectId === projectId,
    };
  });
  return { currentProject, tasks: resourceTasks, summaries };
};

const resolveResourceScheduleScope = (
  context: ProjectResourceScheduleContext,
  rootTaskIds: string[] = [],
  modeOverride: ResourceScheduleModeOverride = "PRESERVE",
): ProjectResourceScheduleScope => {
  const projectTasks = context.tasks.filter((task) => task.projectId === context.currentProject.id);
  const taskById = new Map(projectTasks.map((task) => [task.id, task]));
  const childrenByParentId = new Map<string, string[]>();
  projectTasks.forEach((task) => {
    if (!task.parentId || !taskById.has(task.parentId)) return;
    childrenByParentId.set(task.parentId, [...(childrenByParentId.get(task.parentId) ?? []), task.id]);
  });
  const normalizedRoots = [...new Set(rootTaskIds.map((id) => String(id).trim()).filter(Boolean))];
  if (normalizedRoots.length === 0) {
    return {
      rootTaskIds: [],
      taskIds: projectTasks.filter((task) => task.isLeaf).map((task) => task.id),
      modeOverride,
    };
  }
  normalizedRoots.forEach((rootId) => {
    if (!taskById.has(rootId)) throw new Error("自动排期范围包含不属于当前项目的任务");
    if ((childrenByParentId.get(rootId) ?? []).length === 0) throw new Error("自动排期只能选择父级任务范围");
  });
  const leafIds = new Set<string>();
  const visit = (taskId: string) => {
    const childIds = childrenByParentId.get(taskId) ?? [];
    if (childIds.length === 0) {
      leafIds.add(taskId);
      return;
    }
    childIds.forEach(visit);
  };
  normalizedRoots.forEach(visit);
  return { rootTaskIds: normalizedRoots, taskIds: [...leafIds], modeOverride };
};

export const resourceScheduleAnalysis = async (
  projectId: string,
  options: { scopeRootTaskIds?: string[]; modeOverride?: ResourceScheduleModeOverride } = {},
) => {
  const context = await loadProjectResourceScheduleContext(projectId);
  const scope = resolveResourceScheduleScope(
    context,
    options.scopeRootTaskIds,
    options.modeOverride ?? "PRESERVE",
  );
  const result = createResourceScheduleCandidates({
    tasks: context.tasks,
    currentProjectId: projectId,
    calendarMode: context.currentProject.ganttCalendarMode === "WORKING_DAYS" ? "WORKING_DAYS" : "CALENDAR_DAYS",
    expectedEndDate: context.currentProject.expectedEndDate,
    hardFinishDate: context.currentProject.ganttHardFinishDate,
    scopeTaskIds: scope.taskIds,
    modeOverride: scope.modeOverride,
  });
  return { context, result, scope };
};

export const resourceConflictAnalysis = async (projectId: string) => {
  const context = await loadProjectResourceScheduleContext(projectId);
  const currentTaskIds = new Set(
    context.tasks.filter((task) => task.projectId === projectId).map((task) => task.id),
  );
  return {
    context,
    result: {
      snapshotHash: resourceScheduleSnapshotHash(context.tasks),
      conflicts: detectResourceConflicts(
        context.tasks,
        context.currentProject.ganttCalendarMode === "WORKING_DAYS" ? "WORKING_DAYS" : "CALENDAR_DAYS",
      )
        .filter((conflict) => conflict.taskIds.some((taskId) => currentTaskIds.has(taskId))),
      issues: detectResourceScheduleIssues(
        context.tasks,
        context.currentProject.ganttCalendarMode === "WORKING_DAYS" ? "WORKING_DAYS" : "CALENDAR_DAYS",
      ).filter((issue) => issue.taskIds.some((taskId) => currentTaskIds.has(taskId))),
    },
  };
};

/**
 * Previews a manual timing edit without persisting it. The caller uses the
 * result to show the project manager exactly which dependency, parent-window
 * or capacity consequences require acknowledgement before the save proceeds.
 */
export const previewProjectManualScheduleImpact = async (params: {
  projectId: string;
  taskId: string;
  patch: ManualSchedulePreviewPatch;
}): Promise<ProjectManualScheduleImpact> => {
  const context = await loadProjectResourceScheduleContext(params.projectId);
  const currentProjectTasks = context.tasks.filter((task) => task.projectId === params.projectId);
  const preview = collectManualScheduleImpactTaskIds(
    currentProjectTasks,
    params.taskId,
    params.patch,
  );
  const affectedTaskIdSet = new Set(preview.affectedTaskIds);
  const patchedCurrentTaskById = new Map(preview.patchedTasks.map((task) => [task.id, task]));
  const patchedTasks = context.tasks.map((task) => {
    const patched = patchedCurrentTaskById.get(task.id);
    return patched ?? task;
  });

  const mode = context.currentProject.ganttCalendarMode === "WORKING_DAYS" ? "WORKING_DAYS" : "CALENDAR_DAYS";
  const issues = detectResourceScheduleIssues(patchedTasks, mode)
    .filter((issue) => issue.taskIds.some((taskId) => affectedTaskIdSet.has(taskId)));
  const conflicts = detectResourceConflicts(patchedTasks, mode)
    .filter((conflict) => conflict.taskIds.some((taskId) => affectedTaskIdSet.has(taskId)));
  const patchedTaskById = new Map(patchedTasks.map((task) => [task.id, task]));
  const affectedTasks = context.summaries
    .filter((summary) => affectedTaskIdSet.has(summary.id))
    .map((summary) => {
      const patched = patchedTaskById.get(summary.id);
      return patched ? {
        ...summary,
        startDate: patched.startDate,
        finishDate: patched.finishDate,
      } : summary;
    });

  return {
    requiresConfirmation: issues.length > 0 || conflicts.length > 0 || preview.affectedTaskIds.length > 1,
    affectedTaskIds: preview.affectedTaskIds,
    affectedTasks,
    issues,
    conflicts,
  };
};

const canExposeExternalDetails = (isAdmin: boolean) => isAdmin;

export const serializeResourceConflict = (
  conflict: ResourceConflict,
  summaries: ResourceTaskSummary[],
  isAdmin: boolean,
) => ({
  ...conflict,
  tasks: conflict.taskIds.flatMap((taskId) => {
    const summary = summaries.find((item) => item.id === taskId);
    if (!summary) return [];
    if (summary.isCurrentProject || canExposeExternalDetails(isAdmin)) return [summary];
    return [{ ...summary, projectName: "其他项目", taskName: "受权限保护的任务", taskCode: "" }];
  }),
});

export const serializeResourceCandidate = (
  candidate: ResourceScheduleCandidate,
  summaries: ResourceTaskSummary[],
  isAdmin: boolean,
) => ({
  ...candidate,
  remainingConflicts: candidate.remainingConflicts.map((conflict) => serializeResourceConflict(conflict, summaries, isAdmin)),
  changes: candidate.changes.map((change) => ({
    ...change,
    task: summaries.find((summary) => summary.id === change.taskId) ?? null,
  })),
});

export const applyProjectResourceScheduleCandidate = async (params: {
  projectId: string;
  candidateKind: ResourceScheduleCandidateKind;
  expectedRevision: number;
  expectedSnapshotHash: string;
  operator: string;
  scopeRootTaskIds?: string[];
  modeOverride?: ResourceScheduleModeOverride;
}) => {
  if (!RESOURCE_SCHEDULE_CANDIDATE_KINDS.includes(params.candidateKind)) {
    throw new Error("优化排期方案无效");
  }
  const { context, result, scope } = await resourceScheduleAnalysis(params.projectId, {
    scopeRootTaskIds: params.scopeRootTaskIds,
    modeOverride: params.modeOverride,
  });
  if (["COMPLETED", "VOIDED"].includes(context.currentProject.status)) {
    throw new Error("项目已作废或已完成，不允许修改");
  }
  if (
    params.expectedRevision !== context.currentProject.ganttRevision
    || params.expectedSnapshotHash !== result.snapshotHash
  ) {
    throw new Error("优化排期方案已过期，请重新计算");
  }
  const candidate = result.candidates.find((item) => item.kind === params.candidateKind);
  if (!candidate) throw new Error("优化排期方案不存在");
  if (!candidate.applicable) throw new Error("当前方案无法减少资源冲突，请调整固定任务或负责人");

  await prisma.$transaction(async (tx) => {
    const revision = await tx.project.updateMany({
      where: { id: params.projectId, ganttRevision: params.expectedRevision },
      data: { ganttRevision: { increment: 1 } },
    });
    if (revision.count !== 1) throw new Error("优化排期方案已过期，请重新计算");
    for (const change of candidate.changes) {
      const updated = await tx.projectGanttTask.updateMany({
        where: { id: change.taskId, projectId: params.projectId },
        data: {
          startDate: change.startDate,
          finishDate: change.finishDate,
          ...(change.taskMode ? { taskMode: change.taskMode } : {}),
          resourceNotBeforeDate: change.startDate,
          scheduleCalculatedAt: new Date(),
        },
      });
      if (updated.count !== 1) throw new Error("优化排期目标任务已变化，请重新计算");
    }
    await tx.operationHistory.create({
      data: {
        projectId: params.projectId,
        entityType: "PROJECT_GANTT_RESOURCE_SCHEDULE",
        entityId: params.projectId,
        actionType: "UPDATE",
        operator: params.operator,
        detail: `应用${candidate.title}资源排期建议，范围 ${scope.rootTaskIds.length > 0 ? `${scope.rootTaskIds.length} 个父级` : "全项目"}，调整 ${candidate.changes.length} 个任务`,
      },
    });
    await recalculateProjectGanttSchedule(params.projectId, undefined, tx, { preservePlannedDates: true });
  }, { timeout: 30_000, maxWait: 10_000 });

  return {
    message: `已应用${candidate.title}资源排期建议`,
    candidateKind: candidate.kind,
    candidateTitle: candidate.title,
    changedTaskCount: candidate.changes.length,
    changedTaskIds: candidate.changes.map((change) => change.taskId),
  };
};
