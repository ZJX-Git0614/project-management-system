import { Prisma } from "@prisma/client";

import {
  findGanttHardBoundaryConflicts,
  isValidPlanningDate,
  normalizeGanttScheduleMode,
  UNSUPPORTED_GANTT_DEPENDENCY_REASON,
  validateFsDependencies,
} from "@/lib/gantt-planning-rules";
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
  code: "UNSUPPORTED_DEPENDENCY" | "HARD_BOUNDARY" | "PROJECT_HARD_FINISH" | "INVALID_SCHEDULE" | "UNSCHEDULED" | "INVALID_OWNER_ASSIGNMENT";
  message: string;
  taskIds: string[];
};

export type GanttBaselineValidation = {
  projectId: string;
  taskCount: number;
  valid: boolean;
  blockers: GanttBaselineBlocker[];
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

const hasPlanDates = (task: { startDate: string; finishDate: string }) => (
  isValidPlanningDate(task.startDate) && isValidPlanningDate(task.finishDate)
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
  const [project, tasks, dependencies] = await Promise.all([
    client.project.findUnique({
      where: { id: projectId },
      select: { ganttHardFinishDate: true },
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
        durationDays: true,
        parentBoundaryMode: true,
        scheduleStatus: true,
        ownerMemberId: true,
        ownerLinks: { select: { projectMemberId: true } },
      },
    }),
    client.projectGanttDependency.findMany({
      where: { projectId },
      select: { id: true, predecessorTaskId: true, successorTaskId: true, type: true },
    }),
  ]);
  if (!project) throw new Error("项目不存在");
  const blockers: GanttBaselineBlocker[] = [];
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
  if (isValidPlanningDate(project.ganttHardFinishDate)) {
    const projectHardFinishConflicts = tasks.filter((task) => (
      isValidPlanningDate(task.finishDate) && task.finishDate > project.ganttHardFinishDate
    ));
    if (projectHardFinishConflicts.length > 0) {
      blockers.push({
        code: "PROJECT_HARD_FINISH",
        message: `存在 ${projectHardFinishConflicts.length} 个任务超出项目硬完成边界 ${project.ganttHardFinishDate}，发布基线前必须处理。`,
        taskIds: projectHardFinishConflicts.map((task) => task.id),
      });
    }
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
  return {
    projectId,
    taskCount: tasks.length,
    valid: tasks.length > 0 && blockers.length === 0,
    blockers: tasks.length > 0 ? blockers : [{
      code: "UNSCHEDULED",
      message: "当前项目没有可发布的 WBS 任务。",
      taskIds: [],
    }],
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
