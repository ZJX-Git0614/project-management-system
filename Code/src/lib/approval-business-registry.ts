import { Prisma, type ApprovalWorkflowInstance } from "@prisma/client";

import { PROJECT_STATUS_LABEL } from "@/lib/constants";
import { assertProjectStatusTransition } from "@/lib/project-lifecycle";
import { APPROVAL_BUSINESS_TYPES } from "@/lib/approval-workflow";

type DbClient = Prisma.TransactionClient;

type ApprovalPayload = Record<string, unknown>;

export interface ApprovalBusinessHandler {
  handlerKey: string;
  businessType: string;
  validateStart(db: DbClient, params: { projectId: string; businessId: string; payload: ApprovalPayload }): Promise<void>;
  buildTitle(params: { projectName: string; payload: ApprovalPayload }): string;
  buildSummary(params: { projectName: string; payload: ApprovalPayload }): string;
  apply(db: DbClient, instance: ApprovalWorkflowInstance): Promise<Record<string, unknown>>;
}

const objectPayload = (value: Prisma.JsonValue): ApprovalPayload => (
  value && typeof value === "object" && !Array.isArray(value) ? value as ApprovalPayload : {}
);

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
    const affected = await db.$executeRaw(Prisma.sql`
      UPDATE "ProjectGanttTask"
      SET
        "baselineStartDate" = "startDate",
        "baselineFinishDate" = "finishDate",
        "baselineCost" = "budgetAtCompletion",
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "projectId" = ${instance.projectId}
    `);
    const tasks = await db.projectGanttTask.findMany({
      where: { projectId: instance.projectId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        parentId: true,
        taskCode: true,
        taskName: true,
        startDate: true,
        finishDate: true,
        durationDays: true,
        estimatedWorkHours: true,
        budgetAtCompletion: true,
        baselineStartDate: true,
        baselineFinishDate: true,
        baselineCost: true,
      },
    });
    await db.projectScheduleSnapshot.create({
      data: {
        projectId: instance.projectId,
        sourceFileName: `审批发布基线-r${revision}`,
        schemaVersion: "approval-baseline-v1",
        normalizedJson: JSON.stringify({ revision, publishedAt: new Date().toISOString(), tasks }),
        createdBy: instance.requesterName,
      },
    });
    await db.operationHistory.create({
      data: {
        projectId: instance.projectId,
        entityType: "ProjectGanttTask",
        entityId: instance.projectId,
        actionType: "BASELINE_PUBLISHED",
        operator: instance.requesterName,
        detail: `审批通过后发布 WBS 基线，修订号 ${revision}，共 ${Number(affected)} 条任务`,
      },
    });
    return { ganttRevision: revision, affectedTasks: Number(affected) };
  },
};

const handlers = [projectStatusHandler, wbsBaselineHandler];

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
