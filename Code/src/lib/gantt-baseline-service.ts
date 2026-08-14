import { Prisma } from "@prisma/client";

import {
  findGanttHardBoundaryConflicts,
  isValidPlanningDate,
  normalizeGanttScheduleMode,
  UNSUPPORTED_GANTT_DEPENDENCY_REASON,
  validateFsDependencies,
} from "@/lib/gantt-planning-rules";
import {
  detectResourceConflicts,
  type ResourceSchedulingTask,
} from "@/lib/gantt-resource-schedule";
import {
  abstractDateFromGanttOffset,
  isGanttRelativeOffset,
} from "@/lib/gantt-relative-time";
import { prisma } from "@/lib/prisma";

type GanttBaselineClient = Prisma.TransactionClient | typeof prisma;

export const GANTT_BASELINE_STATES = {
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  CHANGE_DRAFT: "CHANGE_DRAFT",
} as const;

export type GanttBaselineState = typeof GANTT_BASELINE_STATES[keyof typeof GANTT_BASELINE_STATES];

export type GanttBaselineActor = {
  userId: string;
  displayName: string;
};

export type GanttBaselineBlocker = {
  code: "UNSUPPORTED_DEPENDENCY" | "HARD_BOUNDARY" | "INVALID_SCHEDULE" | "UNSCHEDULED" | "INVALID_OWNER_ASSIGNMENT" | "MISSING_DURATION" | "RESOURCE_CONFLICT";
  message: string;
  taskIds: string[];
};

export type GanttBaselineWarning = {
  code: "CROSS_PROJECT_RESOURCE_CONFLICT";
  message: string;
  taskIds: string[];
  projectIds: string[];
};

export type GanttBaselineValidation = {
  projectId: string;
  taskCount: number;
  valid: boolean;
  blockers: GanttBaselineBlocker[];
  warnings: GanttBaselineWarning[];
};

export type GanttBaselinePermissionInput = {
  baselineState: GanttBaselineState | string | null | undefined;
  baselineVersion: number;
  canMaintainDraft: boolean;
  canPublishBaseline: boolean;
  isProjectManager: boolean;
};

export type GanttBaselinePermissions = {
  canPrepareDraft: boolean;
  canPublish: boolean;
  canEditPlanning: boolean;
  canEditActuals: boolean;
  planningMutationBlocker: string | null;
};

type BaselineComparableGanttTask = {
  taskName: string;
  taskDescription: string;
  startDate: string;
  finishDate: string;
  startSlot: string;
  finishSlot: string;
  durationDays: number;
  taskMode: string;
  parentBoundaryMode: string;
  schedulePriority: number;
  userPriority: string;
  effortDriven: boolean;
  parallelizable: boolean;
  isMilestone: boolean;
  budgetItemId: string | null;
  predecessorTask: string;
  remark: string;
  resourceNotBeforeDate?: string;
  constraintType?: number | null;
  constraintDate?: string;
  ownerMemberId: string | null;
  ownerLinks?: Array<{ projectMemberId: string }>;
  predecessorDependencies?: Array<{
    predecessorTaskId: string;
    type?: number;
    lag?: number;
    lagFormat?: number;
  }>;
};

const isLeafTask = <T extends { id: string }>(task: T, parentIds: Set<string>) => !parentIds.has(task.id);

const hasPlanDates = (task: {
  startDate: string;
  finishDate: string;
  relativeStartOffsetDays?: number | null;
  relativeFinishOffsetDays?: number | null;
}) => (
  (isValidPlanningDate(task.startDate) && isValidPlanningDate(task.finishDate))
  || (isGanttRelativeOffset(task.relativeStartOffsetDays) && isGanttRelativeOffset(task.relativeFinishOffsetDays))
);

const sameNumber = (left: unknown, right: unknown) => {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && Math.abs(leftNumber - rightNumber) < 0.0001;
};

const normalizedOwnerIds = (task: Pick<BaselineComparableGanttTask, "ownerMemberId" | "ownerLinks">) => {
  const ids = task.ownerLinks?.length
    ? task.ownerLinks.map((link) => link.projectMemberId)
    : task.ownerMemberId ? [task.ownerMemberId] : [];
  return [...new Set(ids.filter(Boolean))].sort();
};

type BaselineResourceMember = {
  id: string;
  accountId: string | null;
  personName: string;
  capacityHoursPerDay: number | null;
  productivityRate: number | null;
  maxConcurrentAssignments: number | null;
};

type BaselineCrossProjectTask = {
  id: string;
  projectId: string;
  parentId: string | null;
  children?: Array<{ id: string }>;
  taskName: string;
  startDate: string;
  finishDate: string;
  durationDays: number;
  durationMinutes: number | null;
  estimatedWorkHours: number | null;
  progress: number;
  taskMode: string;
  effortDriven: boolean;
  parallelizable: boolean;
  sortOrder: number;
  ownerMemberId: string | null;
  ownerLinks: Array<{
    projectMemberId: string;
    unitsPercent: number | null;
    plannedWorkHours: number | null;
  }>;
};

const resourceOwnerKey = (member: BaselineResourceMember | undefined, memberId: string) => {
  if (member?.accountId) return `account:${member.accountId}`;
  if (member?.personName) return `person:${member.personName}`;
  return `member:${memberId}`;
};

const buildCrossProjectResourceTasks = (
  tasks: BaselineCrossProjectTask[],
  memberById: Map<string, BaselineResourceMember>,
): ResourceSchedulingTask[] => {
  const parentIdsByProject = new Map<string, Set<string>>();
  tasks.forEach((task) => {
    if (!task.parentId) return;
    const parentIds = parentIdsByProject.get(task.projectId) ?? new Set<string>();
    parentIds.add(task.parentId);
    parentIdsByProject.set(task.projectId, parentIds);
  });

  return tasks.flatMap((task) => {
    if (
      (task.children?.length ?? 0) > 0
      ||
      parentIdsByProject.get(task.projectId)?.has(task.id)
      || Number(task.durationDays) <= 0
      || Number(task.progress) >= 100
      || !isValidPlanningDate(task.startDate)
      || !isValidPlanningDate(task.finishDate)
    ) return [];
    const ownerIds = normalizedOwnerIds(task);
    const ownerAssignments = ownerIds.map((memberId) => {
      const link = task.ownerLinks.find((ownerLink) => ownerLink.projectMemberId === memberId);
      const member = memberById.get(memberId);
      return {
        ownerKey: resourceOwnerKey(member, memberId),
        unitsPercent: link?.unitsPercent ?? 100,
        plannedWorkHours: link?.plannedWorkHours ?? 0,
        capacityHoursPerDay: member?.capacityHoursPerDay ?? 7.5,
        productivityRate: member?.productivityRate ?? 1,
        maxConcurrentAssignments: member?.maxConcurrentAssignments ?? 0,
      };
    });
    if (ownerAssignments.length === 0) return [];
    return [{
      id: task.id,
      projectId: task.projectId,
      taskName: task.taskName,
      parentId: task.parentId,
      isLeaf: true,
      ownerKeys: ownerAssignments.map((assignment) => assignment.ownerKey),
      ownerAssignments,
      startDate: task.startDate,
      finishDate: task.finishDate,
      durationDays: Number(task.durationDays),
      durationMinutes: Number(task.durationMinutes ?? 0),
      estimatedWorkHours: Number(task.estimatedWorkHours ?? 0),
      progress: Number(task.progress ?? 0),
      taskMode: task.taskMode,
      effortDriven: Boolean(task.effortDriven),
      parallelizable: Boolean(task.parallelizable),
      sortOrder: Number(task.sortOrder ?? 0),
      predecessorDependencies: [],
      isCurrentProject: false,
    } satisfies ResourceSchedulingTask];
  });
};

const findCrossProjectResourceWarnings = async (params: {
  projectId: string;
  calendarMode: "CALENDAR_DAYS" | "WORKING_DAYS";
  currentProjectResourceTasks: ResourceSchedulingTask[];
  currentProjectMembers: BaselineResourceMember[];
  client: GanttBaselineClient;
}): Promise<GanttBaselineWarning[]> => {
  if (params.currentProjectResourceTasks.length === 0) return [];
  // Lightweight test doubles intentionally omit the cross-project query
  // methods. In that case current-project validation still runs, while a
  // cross-project warning cannot be derived without inventing external data.
  if (
    typeof params.client.project.findMany !== "function"
    || typeof params.client.projectMember.findMany !== "function"
  ) return [];

  const currentOwnerKeys = new Set(
    params.currentProjectResourceTasks.flatMap((task) => task.ownerKeys),
  );
  const sharedAccountIds = params.currentProjectMembers
    .filter((member) => member.accountId && currentOwnerKeys.has(resourceOwnerKey(member, member.id)))
    .map((member) => member.accountId as string);
  const unlinkedPersonNames = params.currentProjectMembers
    .filter((member) => !member.accountId && currentOwnerKeys.has(resourceOwnerKey(member, member.id)))
    .map((member) => member.personName);
  if (sharedAccountIds.length === 0 && unlinkedPersonNames.length === 0) return [];

  const otherMembers = await params.client.projectMember.findMany({
    where: {
      projectId: { not: params.projectId },
      OR: [
        ...(sharedAccountIds.length > 0 ? [{ accountId: { in: sharedAccountIds } }] : []),
        ...(unlinkedPersonNames.length > 0
          ? [{ accountId: null, personName: { in: unlinkedPersonNames } }]
          : []),
      ],
    },
    select: {
      id: true,
      projectId: true,
      accountId: true,
      personName: true,
      capacityHoursPerDay: true,
      productivityRate: true,
      maxConcurrentAssignments: true,
    },
  });
  if (otherMembers.length === 0) return [];

  const otherProjectIds = [...new Set(otherMembers.map((member) => member.projectId))];
  const activeProjects = await params.client.project.findMany({
    where: { id: { in: otherProjectIds }, status: { not: "VOIDED" } },
    select: { id: true, name: true },
  });
  if (activeProjects.length === 0) return [];

  const activeProjectIds = new Set(activeProjects.map((project) => project.id));
  const activeOtherMembers = otherMembers.filter((member) => activeProjectIds.has(member.projectId));
  if (activeOtherMembers.length === 0) return [];
  const otherMemberIds = activeOtherMembers.map((member) => member.id);

  const tasks = await params.client.projectGanttTask.findMany({
    where: {
      projectId: { in: [...activeProjectIds] },
      OR: [
        { ownerMemberId: { in: otherMemberIds } },
        { ownerLinks: { some: { projectMemberId: { in: otherMemberIds } } } },
      ],
    },
    select: {
      id: true,
      projectId: true,
      parentId: true,
      children: { select: { id: true }, take: 1 },
      taskName: true,
      startDate: true,
      finishDate: true,
      durationDays: true,
      durationMinutes: true,
      estimatedWorkHours: true,
      progress: true,
      taskMode: true,
      effortDriven: true,
      parallelizable: true,
      sortOrder: true,
      ownerMemberId: true,
      ownerLinks: {
        where: { projectMemberId: { in: otherMemberIds } },
        select: { projectMemberId: true, unitsPercent: true, plannedWorkHours: true },
      },
    },
  });
  const otherProjectTasks = buildCrossProjectResourceTasks(
    tasks as BaselineCrossProjectTask[],
    new Map(activeOtherMembers.map((member) => [member.id, member] as const)),
  );
  if (otherProjectTasks.length === 0) return [];

  const projectNameById = new Map(activeProjects.map((project) => [project.id, project.name] as const));
  const crossProjectConflicts = detectResourceConflicts(
    [...params.currentProjectResourceTasks, ...otherProjectTasks],
    params.calendarMode,
  ).filter((conflict) => (
    conflict.projectIds.includes(params.projectId)
    && conflict.projectIds.some((id) => id !== params.projectId)
  ));
  if (crossProjectConflicts.length === 0) return [];

  const relatedProjectIds = [...new Set(crossProjectConflicts.flatMap((conflict) => conflict.projectIds))]
    .filter((id) => id !== params.projectId)
    .sort();
  const relatedProjectNames = relatedProjectIds
    .map((id) => projectNameById.get(id) || id)
    .join("、");
  const currentTaskIds = [...new Set(crossProjectConflicts.flatMap((conflict) => conflict.taskIds))]
    .filter((taskId) => params.currentProjectResourceTasks.some((task) => task.id === taskId));
  return [{
    code: "CROSS_PROJECT_RESOURCE_CONFLICT",
    message: `存在 ${crossProjectConflicts.length} 组与其他项目共享负责人的容量或并发冲突（${relatedProjectNames}）。该冲突不阻止当前基线发布，但应协调跨项目资源。`,
    taskIds: currentTaskIds,
    projectIds: relatedProjectIds,
  }];
};

const normalizedDependencyKeys = (dependencies: Array<{
  predecessorTaskId: string;
  type?: number;
  lag?: number;
  lagFormat?: number;
}>) => dependencies
  .filter((dependency) => dependency.predecessorTaskId)
  .map((dependency) => [
    dependency.predecessorTaskId,
    Number.isInteger(dependency.type) ? dependency.type : 1,
    Number.isFinite(Number(dependency.lag)) ? Number(dependency.lag) : 0,
    Number.isInteger(dependency.lagFormat) ? dependency.lagFormat : 7,
  ].join(":"))
  .sort();

const normalizeBaselineState = (value: unknown): GanttBaselineState => (
  value === GANTT_BASELINE_STATES.PUBLISHED || value === GANTT_BASELINE_STATES.CHANGE_DRAFT
    ? value
    : GANTT_BASELINE_STATES.DRAFT
);

/**
 * Keeps the permission rules used by the baseline API and planning-settings
 * API in one place. A published baseline allows actuals only; an approved
 * change draft reopens planning fields for its project manager only.
 */
export const getGanttBaselinePermissions = (
  input: GanttBaselinePermissionInput,
): GanttBaselinePermissions => {
  const baselineState = normalizeBaselineState(input.baselineState);
  const canPrepareInitialDraft = input.canMaintainDraft && input.baselineVersion === 0;
  const canPrepareChangeDraft = input.canMaintainDraft
    && input.canPublishBaseline
    && input.isProjectManager
    && input.baselineVersion > 0;
  const canEditPlanning = baselineState === GANTT_BASELINE_STATES.DRAFT
    || (baselineState === GANTT_BASELINE_STATES.CHANGE_DRAFT && input.isProjectManager);
  const planningMutationBlocker = baselineState === GANTT_BASELINE_STATES.PUBLISHED
    ? "WBS 基线已发布。计划字段、任务结构、依赖关系和项目硬边界已锁定；请先由项目经理创建变更基线草案。"
    : baselineState === GANTT_BASELINE_STATES.CHANGE_DRAFT && !input.isProjectManager
      ? "当前处于 WBS 变更基线草案。仅项目经理可以调整计划字段、任务结构、依赖关系和项目硬边界。"
      : null;
  return {
    canPrepareDraft: canPrepareInitialDraft || canPrepareChangeDraft,
    canPublish: input.canPublishBaseline
      && input.isProjectManager
      && baselineState !== GANTT_BASELINE_STATES.PUBLISHED,
    canEditPlanning,
    canEditActuals: true,
    planningMutationBlocker,
  };
};

/**
 * The task editor sends full row drafts. Under a published baseline we must
 * still permit actual-progress updates, while rejecting a genuine change to
 * any planned, structural or dependency field.
 */
export const hasGanttTaskPlanningMutation = (
  existing: BaselineComparableGanttTask,
  body: Record<string, unknown>,
) => {
  const stringFields = [
    "taskName",
    "taskDescription",
    "startDate",
    "finishDate",
    "startSlot",
    "finishSlot",
    "parentBoundaryMode",
    "userPriority",
    "predecessorTask",
    "remark",
    "resourceNotBeforeDate",
    "constraintDate",
  ] as const;
  for (const field of stringFields) {
    if (!(field in body)) continue;
    const next = String(body[field] ?? "").trim();
    const current = String(existing[field] ?? "").trim();
    if (next !== current) return true;
  }
  if ("taskMode" in body && normalizeGanttScheduleMode(String(body.taskMode ?? "")) !== normalizeGanttScheduleMode(existing.taskMode)) {
    return true;
  }
  const numberFields = ["durationDays", "schedulePriority", "constraintType"] as const;
  for (const field of numberFields) {
    if (field in body && !sameNumber(body[field], existing[field] ?? 0)) return true;
  }
  const booleanFields = ["effortDriven", "parallelizable", "isMilestone"] as const;
  for (const field of booleanFields) {
    if (field in body && Boolean(body[field]) !== Boolean(existing[field])) return true;
  }
  if ("budgetItemId" in body && String(body.budgetItemId ?? "") !== String(existing.budgetItemId ?? "")) return true;
  if ("ownerChangeMode" in body && body.ownerChangeMode === "BRANCH_REASSIGN") return true;
  if ("ownerMemberIds" in body || "ownerMemberId" in body) {
    const requested = Array.isArray(body.ownerMemberIds)
      ? [...new Set(body.ownerMemberIds.map((value) => String(value).trim()).filter(Boolean))].sort()
      : body.ownerMemberId ? [String(body.ownerMemberId).trim()] : [];
    if (JSON.stringify(requested) !== JSON.stringify(normalizedOwnerIds(existing))) return true;
  }
  if ("predecessorDependencies" in body || "predecessorTaskIds" in body || "predecessorTaskId" in body) {
    const dependencies = Array.isArray(body.predecessorDependencies)
      ? body.predecessorDependencies.map((value) => {
          const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
          return {
            predecessorTaskId: String(item.predecessorTaskId ?? "").trim(),
            type: Number(item.type ?? 1),
            lag: Number(item.lag ?? 0),
            lagFormat: Number(item.lagFormat ?? 7),
          };
        })
      : (Array.isArray(body.predecessorTaskIds)
        ? body.predecessorTaskIds
        : body.predecessorTaskId ? [body.predecessorTaskId] : []
      ).map((value) => ({ predecessorTaskId: String(value).trim(), type: 1, lag: 0, lagFormat: 7 }));
    if (JSON.stringify(normalizedDependencyKeys(dependencies)) !== JSON.stringify(normalizedDependencyKeys(existing.predecessorDependencies ?? []))) {
      return true;
    }
  }
  return false;
};

/**
 * A published baseline is immutable. This helper deliberately only answers
 * whether planned WBS data may change; project status checks stay in the
 * existing generic mutation guard.
 */
export const getGanttPlanMutationBlockReason = async (
  projectId: string,
  client: GanttBaselineClient = prisma,
): Promise<string | null> => {
  const project = await client.project.findUnique({
    where: { id: projectId },
    select: { ganttBaselineState: true },
  });
  if (!project) return "项目不存在";
  if (project.ganttBaselineState === GANTT_BASELINE_STATES.PUBLISHED) {
    return "WBS 基线已发布。计划字段、任务结构和依赖关系已锁定；请先由项目经理创建变更基线草案。";
  }
  return null;
};

export const isProjectGanttManager = async (
  projectId: string,
  userId: string,
  client: GanttBaselineClient = prisma,
) => {
  const membership = await client.projectMember.findFirst({
    where: { projectId, accountId: userId, roleName: "项目经理" },
    select: { id: true },
  });
  return Boolean(membership);
};

/**
 * Enforces the same planning lock in every WBS write endpoint. A published
 * baseline never permits planning mutations; a change draft permits them only
 * for the current project's project manager. System administration is not a
 * substitute for project ownership here, because a baseline is a project
 * commitment rather than a global system setting.
 */
export const getGanttPlanMutationBlockReasonForActor = async (params: {
  projectId: string;
  userId: string;
  // Kept for request compatibility with older callers. Project-manager
  // membership is intentionally the only authority that unlocks a change
  // draft.
  isAdministrator?: boolean;
  client?: GanttBaselineClient;
}): Promise<string | null> => {
  const client = params.client ?? prisma;
  const project = await client.project.findUnique({
    where: { id: params.projectId },
    select: { ganttBaselineState: true },
  });
  if (!project) return "项目不存在";
  if (project.ganttBaselineState === GANTT_BASELINE_STATES.PUBLISHED) {
    return "WBS 基线已发布。计划字段、任务结构和依赖关系已锁定；请先由项目经理创建变更基线草案。";
  }
  if (project.ganttBaselineState === GANTT_BASELINE_STATES.CHANGE_DRAFT) {
    const canMaintainDraft = await isProjectGanttManager(params.projectId, params.userId, client);
    if (!canMaintainDraft) {
      return "当前处于 WBS 变更基线草案。仅项目经理可以调整计划字段、任务结构、依赖关系和项目硬边界。";
    }
  }
  return null;
};

const captureProjectGanttBaselineSnapshot = async (
  projectId: string,
  client: GanttBaselineClient,
) => {
  const [project, tasks, dependencies] = await Promise.all([
    client.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        code: true,
        startDate: true,
        expectedEndDate: true,
        ganttHardFinishDate: true,
        ganttCalendarMode: true,
        ganttRevision: true,
      },
    }),
    client.projectGanttTask.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
    client.projectGanttDependency.findMany({
      where: { projectId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  if (!project) throw new Error("项目不存在");
  return {
    schemaVersion: "wbs-baseline-v2",
    capturedAt: new Date().toISOString(),
    project,
    tasks,
    dependencies,
  };
};

export const validateProjectGanttBaseline = async (
  projectId: string,
  client: GanttBaselineClient = prisma,
): Promise<GanttBaselineValidation> => {
  const [project, tasks, dependencies, members] = await Promise.all([
    client.project.findUnique({
      where: { id: projectId },
      select: { ganttCalendarMode: true },
    }),
    client.projectGanttTask.findMany({
      where: { projectId },
      select: {
        id: true,
        parentId: true,
        taskCode: true,
        taskName: true,
        startDate: true,
        finishDate: true,
        relativeStartOffsetDays: true,
        relativeFinishOffsetDays: true,
        durationDays: true,
        durationMinutes: true,
        estimatedWorkHours: true,
        progress: true,
        taskMode: true,
        effortDriven: true,
        parallelizable: true,
        sortOrder: true,
        isMilestone: true,
        parentBoundaryMode: true,
        scheduleStatus: true,
        ownerMemberId: true,
        ownerLinks: { select: { projectMemberId: true, unitsPercent: true, plannedWorkHours: true } },
      },
    }),
    client.projectGanttDependency.findMany({
      where: { projectId },
      select: { id: true, predecessorTaskId: true, successorTaskId: true, type: true },
    }),
    client.projectMember.findMany({
      where: { projectId },
      select: {
        id: true,
        accountId: true,
        personName: true,
        capacityHoursPerDay: true,
        productivityRate: true,
        maxConcurrentAssignments: true,
      },
    }),
  ]);
  if (!project) throw new Error("项目不存在");
  const blockers: GanttBaselineBlocker[] = [];
  const warnings: GanttBaselineWarning[] = [];
  const unsupportedDependencies = dependencies.filter((dependency) => validateFsDependencies([dependency]).length > 0);
  if (unsupportedDependencies.length > 0) {
    blockers.push({
      code: "UNSUPPORTED_DEPENDENCY",
      message: `${UNSUPPORTED_GANTT_DEPENDENCY_REASON}。请处理后再发布基线。`,
      taskIds: [...new Set(unsupportedDependencies.flatMap((dependency) => [dependency.predecessorTaskId, dependency.successorTaskId]))],
    });
  }
  const hardBoundaryConflicts = findGanttHardBoundaryConflicts(tasks);
  if (hardBoundaryConflicts.length > 0) {
    blockers.push({
      code: "HARD_BOUNDARY",
      message: `存在 ${hardBoundaryConflicts.length} 个任务超出父任务硬边界，发布基线前必须处理。`,
      taskIds: hardBoundaryConflicts.map((conflict) => conflict.taskId),
    });
  }
  const invalidScheduleTasks = tasks.filter((task) => task.scheduleStatus === "INVALID_DEPENDENCY");
  if (invalidScheduleTasks.length > 0) {
    blockers.push({
      code: "INVALID_SCHEDULE",
      message: `存在 ${invalidScheduleTasks.length} 个任务的依赖网络无效，不能发布基线。`,
      taskIds: invalidScheduleTasks.map((task) => task.id),
    });
  }
  const parentIds = new Set(tasks.map((task) => task.parentId).filter((id): id is string => Boolean(id)));
  const invalidOwnerAssignments = tasks.filter((task) => (
    isLeafTask(task, parentIds)
    && normalizedOwnerIds(task).length > 1
  ));
  if (invalidOwnerAssignments.length > 0) {
    blockers.push({
      code: "INVALID_OWNER_ASSIGNMENT",
      message: `存在 ${invalidOwnerAssignments.length} 个叶子任务配置了多名直接负责人。叶子任务只能指定一名负责人；父级负责人由子任务自动汇总。`,
      taskIds: invalidOwnerAssignments.map((task) => task.id),
    });
  }
  const scheduledLeafTasks = tasks.filter((task) => (
    isLeafTask(task, parentIds)
    && Number(task.durationDays) > 0
    && hasPlanDates(task)
    && Number(task.progress) < 100
  ));
  const hasConcreteDates = scheduledLeafTasks.some((task) => (
    isValidPlanningDate(task.startDate) && isValidPlanningDate(task.finishDate)
  ));
  const hasRelativeDates = scheduledLeafTasks.some((task) => (
    isGanttRelativeOffset(task.relativeStartOffsetDays) && isGanttRelativeOffset(task.relativeFinishOffsetDays)
    && !(isValidPlanningDate(task.startDate) && isValidPlanningDate(task.finishDate))
  ));
  if (hasConcreteDates && hasRelativeDates) {
    blockers.push({
      code: "INVALID_SCHEDULE",
      message: "项目同时存在具体日期与未换算的 T0 相对计划，无法可靠校验资源容量；请先填写项目 T0 并统一换算后再发布基线。",
      taskIds: scheduledLeafTasks.map((task) => task.id),
    });
  } else if (scheduledLeafTasks.length > 0) {
    const memberById = new Map<string, BaselineResourceMember>(members.map((member) => [member.id, member]));
    const usesRelativeCalendar = hasRelativeDates && !hasConcreteDates;
    const resourceTasks: ResourceSchedulingTask[] = scheduledLeafTasks.flatMap((task) => {
      const assignments = normalizedOwnerIds(task).map((memberId) => {
        const member = memberById.get(memberId);
        const link = task.ownerLinks.find((ownerLink) => ownerLink.projectMemberId === memberId);
        return {
          ownerKey: resourceOwnerKey(member, memberId),
          unitsPercent: link?.unitsPercent ?? 100,
          plannedWorkHours: link?.plannedWorkHours ?? 0,
          capacityHoursPerDay: member?.capacityHoursPerDay ?? 7.5,
          productivityRate: member?.productivityRate ?? 1,
          maxConcurrentAssignments: member?.maxConcurrentAssignments ?? 0,
        };
      });
      if (assignments.length === 0) return [];
      const relativeStartOffsetDays = task.relativeStartOffsetDays;
      const relativeFinishOffsetDays = task.relativeFinishOffsetDays;
      const relative = usesRelativeCalendar
        && isGanttRelativeOffset(relativeStartOffsetDays)
        && isGanttRelativeOffset(relativeFinishOffsetDays);
      const scheduledStartDate = relative && isGanttRelativeOffset(relativeStartOffsetDays)
        ? abstractDateFromGanttOffset(relativeStartOffsetDays)
        : task.startDate;
      const scheduledFinishDate = relative && isGanttRelativeOffset(relativeFinishOffsetDays)
        ? abstractDateFromGanttOffset(relativeFinishOffsetDays)
        : task.finishDate;
      return [{
        id: task.id,
        projectId,
        projectName: "",
        taskName: task.taskName,
        parentId: task.parentId,
        isLeaf: true,
        ownerKeys: assignments.map((assignment) => assignment.ownerKey),
        ownerAssignments: assignments,
        startDate: scheduledStartDate,
        finishDate: scheduledFinishDate,
        durationDays: Number(task.durationDays),
        durationMinutes: Number(task.durationMinutes ?? 0),
        estimatedWorkHours: Number(task.estimatedWorkHours ?? 0),
        progress: Number(task.progress ?? 0),
        taskMode: task.taskMode,
        effortDriven: Boolean(task.effortDriven),
        parallelizable: Boolean(task.parallelizable),
        sortOrder: Number(task.sortOrder ?? 0),
        predecessorDependencies: [],
        isCurrentProject: true,
      } satisfies ResourceSchedulingTask];
    });
    const resourceConflicts = detectResourceConflicts(
      resourceTasks,
      usesRelativeCalendar ? "CALENDAR_DAYS" : project.ganttCalendarMode === "WORKING_DAYS" ? "WORKING_DAYS" : "CALENDAR_DAYS",
    );
    if (resourceConflicts.length > 0) {
      blockers.push({
        code: "RESOURCE_CONFLICT",
        message: `存在 ${resourceConflicts.length} 组同一负责人容量或并发冲突，发布基线前必须应用排期方案或调整负责人、工期。`,
        taskIds: [...new Set(resourceConflicts.flatMap((conflict) => conflict.taskIds))],
      });
    }
    if (!usesRelativeCalendar) {
      warnings.push(...await findCrossProjectResourceWarnings({
        projectId,
        calendarMode: project.ganttCalendarMode === "WORKING_DAYS" ? "WORKING_DAYS" : "CALENDAR_DAYS",
        currentProjectResourceTasks: resourceTasks,
        currentProjectMembers: members,
        client,
      }));
    }
  }
  const unscheduledLeafTasks = tasks.filter((task) => (
    isLeafTask(task, parentIds)
    && Number(task.durationDays) > 0
    && !hasPlanDates(task)
  ));
  if (unscheduledLeafTasks.length > 0) {
    blockers.push({
      code: "UNSCHEDULED",
      message: `存在 ${unscheduledLeafTasks.length} 个叶子任务尚未完成排期，不能发布基线。`,
      taskIds: unscheduledLeafTasks.map((task) => task.id),
    });
  }
  const missingDurationLeafTasks = tasks.filter((task) => (
    isLeafTask(task, parentIds)
    && !task.isMilestone
    && Number(task.durationDays) <= 0
  ));
  if (missingDurationLeafTasks.length > 0) {
    blockers.push({
      code: "MISSING_DURATION",
      message: `存在 ${missingDurationLeafTasks.length} 个叶子任务缺少已确认的正式工期，不能发布基线。`,
      taskIds: missingDurationLeafTasks.map((task) => task.id),
    });
  }
  return {
    projectId,
    taskCount: tasks.length,
    valid: tasks.length > 0 && blockers.length === 0,
    blockers: tasks.length > 0 ? blockers : [{
      code: "UNSCHEDULED",
      message: "当前项目没有可发布的 WBS 任务。",
      taskIds: [],
    }],
    warnings,
  };
};

export const beginProjectGanttBaselineDraft = async (params: {
  projectId: string;
  actor: GanttBaselineActor;
  reason?: string;
}) => prisma.$transaction(async (tx) => {
  const project = await tx.project.findUnique({
    where: { id: params.projectId },
    select: { id: true, ganttBaselineVersion: true, ganttBaselineState: true, ganttRevision: true },
  });
  if (!project) throw new Error("项目不存在");
  const snapshot = await captureProjectGanttBaselineSnapshot(params.projectId, tx);
  const reason = String(params.reason ?? "").trim();
  const draft = await tx.projectGanttBaselineDraft.upsert({
    where: { projectId: params.projectId },
    create: {
      projectId: params.projectId,
      baseVersion: project.ganttBaselineVersion,
      sourceRevision: project.ganttRevision,
      reason,
      snapshotJson: JSON.stringify(snapshot),
      createdByUserId: params.actor.userId,
      createdByName: params.actor.displayName,
      updatedByUserId: params.actor.userId,
      updatedByName: params.actor.displayName,
    },
    update: {
      baseVersion: project.ganttBaselineVersion,
      sourceRevision: project.ganttRevision,
      status: "ACTIVE",
      reason,
      snapshotJson: JSON.stringify(snapshot),
      updatedByUserId: params.actor.userId,
      updatedByName: params.actor.displayName,
    },
  });
  await tx.project.update({
    where: { id: params.projectId },
    data: {
      ganttBaselineState: project.ganttBaselineVersion > 0
        ? GANTT_BASELINE_STATES.CHANGE_DRAFT
        : GANTT_BASELINE_STATES.DRAFT,
    },
  });
  await tx.operationHistory.create({
    data: {
      projectId: params.projectId,
      entityType: "ProjectGanttTask",
      entityId: params.projectId,
      actionType: "BASELINE_DRAFT_STARTED",
      operator: params.actor.displayName,
      detail: `创建 WBS ${project.ganttBaselineVersion > 0 ? "变更" : "发布"}基线草案（基线版本 ${project.ganttBaselineVersion}，修订号 ${project.ganttRevision}）${reason ? `：${reason}` : ""}`,
    },
  });
  return { draft, baselineState: project.ganttBaselineVersion > 0 ? GANTT_BASELINE_STATES.CHANGE_DRAFT : GANTT_BASELINE_STATES.DRAFT };
}, { timeout: 30_000, maxWait: 10_000 });

export const publishProjectGanttBaseline = async (params: {
  projectId: string;
  actor: GanttBaselineActor;
  reason?: string;
}) => prisma.$transaction(async (tx) => {
  const project = await tx.project.findUnique({
    where: { id: params.projectId },
    select: { id: true, name: true, ganttBaselineVersion: true, ganttRevision: true, status: true },
  });
  if (!project) throw new Error("项目不存在");
  if (project.status === "COMPLETED" || project.status === "VOIDED") {
    throw new Error("已完成或已作废的项目不能发布新的 WBS 基线");
  }
  const validation = await validateProjectGanttBaseline(params.projectId, tx);
  if (!validation.valid) {
    throw new Error(validation.blockers.map((blocker) => blocker.message).join("\n"));
  }
  const snapshot = await captureProjectGanttBaselineSnapshot(params.projectId, tx);
  const version = project.ganttBaselineVersion + 1;
  const reason = String(params.reason ?? "").trim();
  const baseline = await tx.projectGanttBaseline.create({
    data: {
      projectId: params.projectId,
      version,
      status: "PUBLISHED",
      sourceRevision: project.ganttRevision,
      reason,
      impactJson: JSON.stringify({ blockers: [], taskCount: validation.taskCount }),
      snapshotJson: JSON.stringify(snapshot),
      createdByUserId: params.actor.userId,
      createdByName: params.actor.displayName,
    },
  });
  const affectedTasks = await tx.$executeRaw(Prisma.sql`
    UPDATE "ProjectGanttTask"
    SET
      "baselineStartDate" = "startDate",
      "baselineFinishDate" = "finishDate",
      "baselineCost" = "budgetAtCompletion",
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "projectId" = ${params.projectId}
  `);
  await tx.project.update({
    where: { id: params.projectId },
    data: {
      ganttBaselineVersion: version,
      ganttBaselineState: GANTT_BASELINE_STATES.PUBLISHED,
      ganttBaselinePublishedAt: new Date(),
      ganttBaselinePublishedBy: params.actor.displayName,
    },
  });
  await tx.projectGanttBaselineDraft.deleteMany({ where: { projectId: params.projectId } });
  const recipients = await tx.projectMember.findMany({
    where: { projectId: params.projectId, accountId: { not: null } },
    select: { accountId: true },
  });
  const notificationRows = [...new Set(recipients.map((member) => member.accountId).filter((id): id is string => Boolean(id)))].map((accountId) => ({
    projectId: params.projectId,
    accountId,
    category: "WBS_BASELINE",
    title: `WBS 基线 V${version} 已发布`,
    detail: `${project.name} 的 WBS 基线 V${version} 已由 ${params.actor.displayName} 发布${reason ? `：${reason}` : ""}`,
    severity: "INFO",
    sourceType: "ProjectGanttBaseline",
    sourceId: baseline.id,
  }));
  if (notificationRows.length > 0) await tx.systemNotification.createMany({ data: notificationRows });
  await tx.operationHistory.create({
    data: {
      projectId: params.projectId,
      entityType: "ProjectGanttTask",
      entityId: baseline.id,
      actionType: "BASELINE_PUBLISHED",
      operator: params.actor.displayName,
      detail: `发布 WBS 基线 V${version}，固化 ${Number(affectedTasks)} 条任务${reason ? `：${reason}` : ""}`,
    },
  });
  return { baseline, validation, affectedTasks: Number(affectedTasks) };
}, { timeout: 30_000, maxWait: 10_000 });

export const getProjectGanttBaselineOverview = async (projectId: string) => {
  const [project, baseline, draft, validation] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: {
        ganttBaselineVersion: true,
        ganttBaselineState: true,
        ganttBaselinePublishedAt: true,
        ganttBaselinePublishedBy: true,
      },
    }),
    prisma.projectGanttBaseline.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
      select: { id: true, version: true, status: true, sourceRevision: true, reason: true, createdAt: true, createdByName: true },
    }),
    prisma.projectGanttBaselineDraft.findUnique({
      where: { projectId },
      select: { id: true, baseVersion: true, sourceRevision: true, status: true, reason: true, updatedAt: true, updatedByName: true },
    }),
    validateProjectGanttBaseline(projectId),
  ]);
  if (!project) throw new Error("项目不存在");
  return { project, baseline, draft, validation };
};
