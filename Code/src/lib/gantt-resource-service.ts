import { prisma } from "@/lib/prisma";
import {
  createResourceScheduleCandidates,
  detectResourceConflicts,
  resourceScheduleSnapshotHash,
  type ResourceConflict,
  type ResourceScheduleCandidate,
  type ResourceScheduleCandidateKind,
  type ResourceSchedulingTask,
} from "@/lib/gantt-resource-schedule";
import { recalculateProjectGanttSchedule } from "@/lib/gantt-task-service";

export const RESOURCE_SCHEDULE_CANDIDATE_KINDS: readonly ResourceScheduleCandidateKind[] = [
  "MINIMAL_CHANGE",
  "EARLIEST_FINISH",
  "ON_TIME",
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
    ganttCalendarMode: string;
    ganttRevision: number;
    status: string;
  };
  tasks: ResourceSchedulingTask[];
  summaries: ResourceTaskSummary[];
}

export const loadProjectResourceScheduleContext = async (projectId: string): Promise<ProjectResourceScheduleContext> => {
  const projects = await prisma.project.findMany({
    where: { status: { not: "VOIDED" } },
    select: { id: true, name: true, expectedEndDate: true, ganttCalendarMode: true, ganttRevision: true, status: true },
  });
  const currentProject = projects.find((project) => project.id === projectId);
  if (!currentProject) throw new Error("项目不存在");
  const tasks = await prisma.projectGanttTask.findMany({
    where: { projectId: { in: projects.map((project) => project.id) } },
    orderBy: [{ projectId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    include: {
      ownerMember: { select: { id: true, accountId: true, personName: true } },
      ownerLinks: {
        orderBy: { createdAt: "asc" },
        include: { projectMember: { select: { id: true, accountId: true, personName: true } } },
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
    const owners = task.ownerLinks.length > 0
      ? task.ownerLinks.map((link) => link.projectMember)
      : task.ownerMember ? [task.ownerMember] : [];
    return {
      id: task.id,
      projectId: task.projectId,
      projectName: projectById.get(task.projectId)?.name,
      taskName: task.taskName,
      parentId: task.parentId,
      isLeaf: !(parentIdsByProject.get(task.projectId)?.has(task.id) ?? false),
      ownerKeys: [...new Set(owners.map((owner) => owner.accountId ? `account:${owner.accountId}` : `person:${owner.personName}`))],
      startDate: task.startDate,
      finishDate: task.finishDate,
      durationDays: task.durationDays,
      durationMinutes: task.durationMinutes,
      estimatedWorkHours: task.estimatedWorkHours,
      progress: task.progress,
      taskMode: task.taskMode,
      resourceNotBeforeDate: task.resourceNotBeforeDate,
      sortOrder: task.sortOrder,
      predecessorDependencies: task.predecessorDependencies,
      isCurrentProject: task.projectId === projectId,
    };
  });
  return { currentProject, tasks: resourceTasks, summaries };
};

export const resourceScheduleAnalysis = async (projectId: string) => {
  const context = await loadProjectResourceScheduleContext(projectId);
  const result = createResourceScheduleCandidates({
    tasks: context.tasks,
    currentProjectId: projectId,
    calendarMode: context.currentProject.ganttCalendarMode === "WORKING_DAYS" ? "WORKING_DAYS" : "CALENDAR_DAYS",
    expectedEndDate: context.currentProject.expectedEndDate,
  });
  return { context, result };
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
      conflicts: detectResourceConflicts(context.tasks)
        .filter((conflict) => conflict.taskIds.some((taskId) => currentTaskIds.has(taskId))),
    },
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
}) => {
  if (!RESOURCE_SCHEDULE_CANDIDATE_KINDS.includes(params.candidateKind)) {
    throw new Error("优化排期方案无效");
  }
  const { context, result } = await resourceScheduleAnalysis(params.projectId);
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
        detail: `应用${candidate.title}资源排期建议，调整 ${candidate.changes.length} 个任务`,
      },
    });
    await recalculateProjectGanttSchedule(params.projectId, undefined, tx);
  }, { timeout: 30_000, maxWait: 10_000 });

  return {
    message: `已应用${candidate.title}资源排期建议`,
    candidateKind: candidate.kind,
    candidateTitle: candidate.title,
    changedTaskCount: candidate.changes.length,
    changedTaskIds: candidate.changes.map((change) => change.taskId),
  };
};
