import { Prisma, type ApprovalWorkflowInstance } from "@prisma/client";

import { PROJECT_STATUS_LABEL } from "@/lib/constants";
import { assertProjectStatusTransition } from "@/lib/project-lifecycle";
import {
  APPROVAL_BUSINESS_TYPES,
  approvalBusinessIdForProjectExecutionExitGate,
  approvalBusinessIdForWbsTaskProgressSubmission,
} from "@/lib/approval-workflow";
import { roundGanttHours } from "@/lib/gantt-calendar";
import { normalizeGanttCompletion } from "@/lib/gantt-planning-rules";
import {
  publishProjectGanttBaselineWithClient,
  validateProjectGanttBaseline,
} from "@/lib/gantt-baseline-service";
import {
  convertFixedSuccessorsBlockedByActualCompletion,
  getProjectGanttCalendarMode,
  refreshProjectGanttDerivedState,
} from "@/lib/gantt-task-service";
import { loadProjectExecutionGateEvaluation } from "@/lib/project-execution-gate-service";

type DbClient = Prisma.TransactionClient;

type ApprovalPayload = Record<string, unknown>;

export interface ApprovalBusinessHandler {
  handlerKey: string;
  businessType: string;
  validateStart(
    db: DbClient,
    params: {
      projectId: string;
      businessId: string;
      payload: ApprovalPayload;
      requester: { userId: string; displayName: string };
    },
  ): Promise<void>;
  buildTitle(params: { projectName: string; payload: ApprovalPayload }): string;
  buildSummary(params: { projectName: string; payload: ApprovalPayload }): string;
  apply(db: DbClient, instance: ApprovalWorkflowInstance): Promise<Record<string, unknown>>;
}

const objectPayload = (value: Prisma.JsonValue): ApprovalPayload => (
  value && typeof value === "object" && !Array.isArray(value) ? value as ApprovalPayload : {}
);

const todayString = () => {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const requireDateString = (value: unknown, fieldName: string) => {
  const text = String(value ?? "").trim();
  if (text && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${fieldName}格式应为 YYYY-MM-DD`);
  return text;
};

const normalizeProgressPayload = (
  payload: ApprovalPayload,
  previousProgress?: number,
) => {
  const actualStartDate = requireDateString(payload.actualStartDate, "实际开始时间");
  const actualEndDate = requireDateString(payload.actualEndDate, "实际完成时间");
  const requestedActualWorkHours = Number(payload.actualWorkHours ?? 0);
  if (!Number.isFinite(requestedActualWorkHours) || requestedActualWorkHours < 0) {
    throw new Error("实际工时必须为大于或等于 0 的数字");
  }
  const completion = normalizeGanttCompletion({
    progress: Number(payload.progress),
    actualStartDate,
    actualEndDate,
    previousProgress,
    today: todayString(),
  });
  if (completion.error) throw new Error(completion.error);
  return {
    progress: completion.progress,
    actualStartDate: completion.actualStartDate,
    actualEndDate: completion.actualEndDate,
    actualWorkHours: roundGanttHours(requestedActualWorkHours),
  };
};

const taskIdFromProgressPayload = (payload: ApprovalPayload) => String(payload.taskId || "").trim();

const ensureProjectAllowsWbsProgressSubmission = async (db: DbClient, projectId: string) => {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { status: true } });
  if (!project) throw new Error("项目不存在");
  if (project.status === "COMPLETED" || project.status === "VOIDED") {
    throw new Error("已完成或已作废的项目不能提交 WBS 任务进度");
  }
};

const ensureRequesterIsDirectTaskOwner = async (
  db: DbClient,
  params: { projectId: string; taskId: string; requesterAccountId: string },
) => {
  const task = await db.projectGanttTask.findFirst({
    where: { id: params.taskId, projectId: params.projectId },
    include: {
      ownerMember: { select: { id: true, accountId: true, personName: true } },
      ownerLinks: {
        include: { projectMember: { select: { id: true, accountId: true, personName: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!task) throw new Error("甘特任务不存在");
  const childCount = await db.projectGanttTask.count({ where: { projectId: params.projectId, parentId: params.taskId } });
  if (childCount > 0) throw new Error("只有末级任务可以提交进度审批");
  const ownerAccounts = task.ownerLinks.length > 0
    ? task.ownerLinks.map((link) => link.projectMember.accountId).filter(Boolean)
    : task.ownerMember?.accountId ? [task.ownerMember.accountId] : [];
  if (!ownerAccounts.includes(params.requesterAccountId)) {
    throw new Error("只有末级任务的直接负责人可以提交本人任务进度");
  }
  return task;
};

const projectStatusHandler: ApprovalBusinessHandler = {
  handlerKey: "APPLY_PROJECT_STATUS_CHANGE",
  businessType: APPROVAL_BUSINESS_TYPES.PROJECT_STATUS_CHANGE,
  async validateStart(db, params) {
    const project = await db.project.findUnique({ where: { id: params.projectId }, select: { status: true } });
    if (!project) throw new Error("项目不存在");
    const fromStatus = String(params.payload.fromStatus || "");
    const targetStatus = String(params.payload.targetStatus || "");
    if (project.status !== fromStatus) throw new Error("项目状态已变化，请刷新后重新发起审批");
    assertProjectStatusTransition(project.status, targetStatus);
  },
  buildTitle({ projectName, payload }) {
    const labels = PROJECT_STATUS_LABEL as Record<string, string>;
    const target = labels[String(payload.targetStatus)] ?? String(payload.targetStatus || "未知状态");
    return `${projectName}：项目状态变更为${target}`;
  },
  buildSummary({ payload }) {
    const labels = PROJECT_STATUS_LABEL as Record<string, string>;
    const from = labels[String(payload.fromStatus)] ?? String(payload.fromStatus || "-");
    const target = labels[String(payload.targetStatus)] ?? String(payload.targetStatus || "-");
    return `申请将项目状态从“${from}”变更为“${target}”`;
  },
  async apply(db, instance) {
    const payload = objectPayload(instance.payload);
    const fromStatus = String(payload.fromStatus || "");
    const targetStatus = String(payload.targetStatus || "");
    assertProjectStatusTransition(fromStatus, targetStatus);
    const updated = await db.project.updateMany({
      where: { id: instance.projectId, status: fromStatus },
      data: { status: targetStatus },
    });
    if (updated.count !== 1) throw new Error("项目状态已变化，审批结果未执行，请重新核对");
    await db.operationHistory.create({
      data: {
        projectId: instance.projectId,
        entityType: "Project",
        entityId: instance.projectId,
        actionType: "STATUS_CHANGED",
        operator: instance.requesterName,
        detail: `审批通过后将项目状态从 ${fromStatus} 变更为 ${targetStatus}`,
      },
    });
    return { fromStatus, targetStatus };
  },
};

const wbsBaselineHandler: ApprovalBusinessHandler = {
  handlerKey: "PUBLISH_WBS_BASELINE",
  businessType: APPROVAL_BUSINESS_TYPES.WBS_BASELINE_PUBLISH,
  async validateStart(db, params) {
    const project = await db.project.findUnique({ where: { id: params.projectId }, select: { ganttRevision: true } });
    if (!project) throw new Error("项目不存在");
    const taskCount = await db.projectGanttTask.count({ where: { projectId: params.projectId } });
    if (taskCount === 0) throw new Error("当前项目没有可发布的 WBS 任务");
    const revision = Number(params.payload.ganttRevision);
    if (!Number.isInteger(revision) || revision !== project.ganttRevision) {
      throw new Error("WBS 已发生变化，请刷新后重新发起基线审批");
    }
    const validation = await validateProjectGanttBaseline(params.projectId, db);
    if (!validation.valid) {
      throw new Error(validation.blockers.map((blocker) => blocker.message).join("\n"));
    }
  },
  buildTitle({ projectName }) {
    return `${projectName}：发布 WBS 基线`;
  },
  buildSummary({ payload }) {
    return `固化 WBS 修订号 ${Number(payload.ganttRevision) || 0} 的计划日期、工时和预算成本`;
  },
  async apply(db, instance) {
    const payload = objectPayload(instance.payload);
    const revision = Number(payload.ganttRevision);
    const project = await db.project.findUnique({ where: { id: instance.projectId }, select: { ganttRevision: true } });
    if (!project || project.ganttRevision !== revision) {
      throw new Error("审批期间 WBS 已发生变化，不能发布过期基线");
    }
    const result = await publishProjectGanttBaselineWithClient({
      projectId: instance.projectId,
      actor: {
        userId: instance.requesterAccountId,
        displayName: instance.requesterName,
      },
      reason: String(payload.reason ?? "").trim(),
      client: db,
    });
    return {
      ganttRevision: revision,
      baselineVersion: result.baseline.version,
      affectedTasks: result.affectedTasks,
    };
  },
};

const wbsTaskProgressSubmissionHandler: ApprovalBusinessHandler = {
  handlerKey: "APPLY_WBS_TASK_PROGRESS_SUBMISSION",
  businessType: APPROVAL_BUSINESS_TYPES.WBS_TASK_PROGRESS_SUBMISSION,
  async validateStart(db, params) {
    const taskId = taskIdFromProgressPayload(params.payload);
    if (!taskId) throw new Error("甘特任务不能为空");
    if (params.businessId !== approvalBusinessIdForWbsTaskProgressSubmission(params.projectId, taskId)) {
      throw new Error("WBS 任务进度审批主键不匹配");
    }
    await ensureProjectAllowsWbsProgressSubmission(db, params.projectId);
    const task = await ensureRequesterIsDirectTaskOwner(db, {
      projectId: params.projectId,
      taskId,
      requesterAccountId: params.requester.userId,
    });
    if (task.progress >= 100) throw new Error("已完成的末级任务不能重复提交进度审批");
    normalizeProgressPayload(params.payload, task.progress);
  },
  buildTitle({ projectName, payload }) {
    const taskCode = String(payload.taskCode || "").trim();
    const taskName = String(payload.taskName || "").trim();
    const taskLabel = [taskCode, taskName].filter(Boolean).join(" · ") || "WBS 任务";
    return `${projectName}：${taskLabel}进度提交`;
  },
  buildSummary({ payload }) {
    const normalized = normalizeProgressPayload(payload);
    return `申请更新任务进度为 ${normalized.progress}%，实际开始 ${normalized.actualStartDate || "未填写"}，实际完成 ${normalized.actualEndDate || "未填写"}，实际工时 ${normalized.actualWorkHours}h`;
  },
  async apply(db, instance) {
    const payload = objectPayload(instance.payload);
    const taskId = taskIdFromProgressPayload(payload);
    if (!taskId) throw new Error("甘特任务不能为空");
    await ensureProjectAllowsWbsProgressSubmission(db, instance.projectId);
    const task = await ensureRequesterIsDirectTaskOwner(db, {
      projectId: instance.projectId,
      taskId,
      requesterAccountId: instance.requesterAccountId,
    });
    if (task.progress >= 100) throw new Error("已完成的末级任务不能重复应用进度审批");
    const normalized = normalizeProgressPayload(payload, task.progress);
    const calendarMode = await getProjectGanttCalendarMode(instance.projectId, db);
    const updated = await db.projectGanttTask.updateMany({
      where: { id: taskId, projectId: instance.projectId },
      data: {
        progress: normalized.progress,
        actualStartDate: normalized.actualStartDate,
        actualEndDate: normalized.actualEndDate,
        actualWorkHours: normalized.actualWorkHours,
      },
    });
    if (updated.count !== 1) throw new Error("甘特任务已变化，审批结果未执行，请重新核对");
    const releasedSuccessors = await convertFixedSuccessorsBlockedByActualCompletion(
      instance.projectId,
      [taskId],
      calendarMode,
      db,
    );
    await refreshProjectGanttDerivedState(instance.projectId, calendarMode, db);
    await db.project.update({ where: { id: instance.projectId }, data: { ganttRevision: { increment: 1 } } });
    await db.operationHistory.create({
      data: {
        projectId: instance.projectId,
        entityType: "ProjectGanttTask",
        entityId: taskId,
        actionType: "UPDATE_ACTUAL",
        operator: instance.requesterName,
        detail: `审批通过后更新任务「${task.taskCode} · ${task.taskName}」执行事实：进度 ${task.progress}% → ${normalized.progress}%，实际完成 ${task.actualEndDate || "未填写"} → ${normalized.actualEndDate || "未填写"}`,
      },
    });
    return {
      taskId,
      progress: normalized.progress,
      actualStartDate: normalized.actualStartDate,
      actualEndDate: normalized.actualEndDate,
      actualWorkHours: normalized.actualWorkHours,
      releasedSuccessorTaskIds: releasedSuccessors.map((task) => task.id),
    };
  },
};

const projectExecutionExitGateHandler: ApprovalBusinessHandler = {
  handlerKey: "APPROVE_PROJECT_EXECUTION_EXIT_GATE",
  businessType: APPROVAL_BUSINESS_TYPES.PROJECT_EXECUTION_EXIT_GATE,
  async validateStart(db, params) {
    const executionId = String(params.payload.executionId || "").trim();
    if (!executionId) throw new Error("执行阶段不能为空");
    if (params.businessId !== approvalBusinessIdForProjectExecutionExitGate(params.projectId, executionId)) {
      throw new Error("执行阶段 Gate 审批主键不匹配");
    }
    const { execution, evaluation } = await loadProjectExecutionGateEvaluation(db, params.projectId, executionId);
    if (execution.status === "COMPLETED" || execution.status === "ARCHIVED") throw new Error("已完成或已归档的阶段不能重复申请出口 Gate");
    if (!evaluation.passed) throw new Error(evaluation.criteria.filter((criterion) => criterion.required && criterion.status !== "PASSED").map((criterion) => criterion.summary).join("\n"));
  },
  buildTitle({ projectName, payload }) {
    return `${projectName}：${String(payload.executionName || "执行阶段")}出口 Gate 放行`;
  },
  buildSummary({ payload }) {
    return `申请放行执行阶段「${String(payload.executionName || "") || "未命名阶段"}」：${String(payload.requestNote || "未填写说明")}`;
  },
  async apply(db, instance) {
    const payload = objectPayload(instance.payload);
    const executionId = String(payload.executionId || "").trim();
    if (!executionId) throw new Error("执行阶段不能为空");
    const { execution, evaluation } = await loadProjectExecutionGateEvaluation(db, instance.projectId, executionId);
    if (!evaluation.passed) throw new Error("审批期间阶段出口条件已不满足，请重新评估后申请");
    if (Number(payload.ganttRevision) !== evaluation.ganttRevision || String(payload.rangeHash || "") !== evaluation.rangeHash) {
      throw new Error("审批期间 WBS 或阶段范围已变化，请重新评估后申请");
    }
    const gateId = String(payload.gateId || "").trim();
    const gate = gateId ? await db.projectExecutionGate.findFirst({ where: { id: gateId, projectId: instance.projectId, executionId } }) : null;
    if (!gate) throw new Error("阶段 Gate 记录不存在");
    const approvedAt = new Date();
    await db.projectExecution.update({
      where: { id: executionId, projectId: instance.projectId },
      data: { status: "COMPLETED" },
    });
    await db.projectExecutionGate.update({
      where: { id: gate.id },
      data: { status: "APPROVED", approvedAt, approvalInstanceId: instance.id, decisionSummary: "审批通过，阶段出口已放行" },
    });
    await db.operationHistory.create({
      data: {
        projectId: instance.projectId,
        entityType: "PROJECT_EXECUTION_GATE",
        entityId: gate.id,
        actionType: "APPROVE",
        operator: instance.requesterName,
        detail: `审批通过，执行阶段「${execution.name}」出口 Gate 已放行。审批实例：${instance.id}`,
      },
    });
    return { gateId: gate.id, executionId, ganttRevision: evaluation.ganttRevision, rangeHash: evaluation.rangeHash, approvedAt: approvedAt.toISOString() };
  },
};

const handlers = [projectStatusHandler, wbsBaselineHandler, wbsTaskProgressSubmissionHandler, projectExecutionExitGateHandler];

const byBusinessType = new Map(handlers.map((handler) => [handler.businessType, handler]));
const byHandlerKey = new Map(handlers.map((handler) => [handler.handlerKey, handler]));

export const getApprovalBusinessHandler = (businessType: string) => {
  const handler = byBusinessType.get(businessType);
  if (!handler) throw new Error(`未注册审批业务类型：${businessType}`);
  return handler;
};

export const getApprovalCompletionHandler = (handlerKey: string) => {
  const handler = byHandlerKey.get(handlerKey);
  if (!handler) throw new Error(`未注册审批完成处理器：${handlerKey}`);
  return handler;
};

export const listApprovalBusinessCapabilities = () => handlers.map((handler) => ({
  businessType: handler.businessType,
  handlerKey: handler.handlerKey,
}));
