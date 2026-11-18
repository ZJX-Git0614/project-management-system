import type { Prisma, ProjectExecutionGate } from "@prisma/client";

import {
  APPROVAL_BUSINESS_TYPES,
  approvalBusinessIdForProjectExecutionExitGate,
} from "@/lib/approval-workflow";
import { startApprovalWorkflow } from "@/lib/approval-workflow-server";
import { gateCriteriaCreateData } from "@/lib/project-execution-gate";
import { loadProjectExecutionGateEvaluation } from "@/lib/project-execution-gate-service";
import { prisma } from "@/lib/prisma";
import type { AuthenticatedUser } from "@/lib/server-auth";

const serializeEvaluation = (evaluation: Awaited<ReturnType<typeof loadProjectExecutionGateEvaluation>>["evaluation"]) => ({
  executionId: evaluation.executionId,
  projectId: evaluation.projectId,
  ganttRevision: evaluation.ganttRevision,
  rangeHash: evaluation.rangeHash,
  snapshotHash: evaluation.snapshotHash,
  passed: evaluation.passed,
  criteria: evaluation.criteria,
});

export type RequestExecutionGateParams = {
  projectId: string;
  executionId: string;
  requestNote: string;
  requester: AuthenticatedUser;
};

export type RequestExecutionGateResult = {
  gate: ProjectExecutionGate;
  approvalInstanceId: string;
};

export const requestExecutionGate = async (
  params: RequestExecutionGateParams,
): Promise<RequestExecutionGateResult> => {
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const { execution, evaluation } = await loadProjectExecutionGateEvaluation(
      tx,
      params.projectId,
      params.executionId,
    );
    if (execution.status === "COMPLETED" || execution.status === "ARCHIVED") {
      throw new Error("已完成或已归档的阶段不能重复申请出口 Gate");
    }
    if (!evaluation.passed) {
      throw new Error(
        evaluation.criteria
          .filter((criterion) => criterion.required && criterion.status !== "PASSED")
          .map((criterion) => criterion.summary)
          .join("\n"),
      );
    }

    const gate = await tx.projectExecutionGate.create({
      data: {
        projectId: params.projectId,
        executionId: params.executionId,
        status: "READY",
        ganttRevision: evaluation.ganttRevision,
        rangeHash: evaluation.rangeHash,
        snapshotJson: JSON.stringify(serializeEvaluation(evaluation)),
        requestNote: params.requestNote,
        criteria: { createMany: { data: gateCriteriaCreateData(evaluation.criteria) } },
      },
    });
    const instance = await startApprovalWorkflow({
      projectId: params.projectId,
      businessType: APPROVAL_BUSINESS_TYPES.PROJECT_EXECUTION_EXIT_GATE,
      businessId: approvalBusinessIdForProjectExecutionExitGate(params.projectId, params.executionId),
      requester: params.requester,
      db: tx,
      payload: {
        gateId: gate.id,
        executionId: params.executionId,
        executionName: execution.name,
        ganttRevision: evaluation.ganttRevision,
        rangeHash: evaluation.rangeHash,
        snapshotHash: evaluation.snapshotHash,
        requestNote: params.requestNote,
      },
    });
    const pendingGate = await tx.projectExecutionGate.update({
      where: { id: gate.id },
      data: { status: "PENDING_APPROVAL", requestedAt: new Date(), approvalInstanceId: instance.id },
    });
    await tx.operationHistory.create({
      data: {
        projectId: params.projectId,
        entityType: "PROJECT_EXECUTION_GATE",
        entityId: pendingGate.id,
        actionType: "REQUEST",
        operator: params.requester.displayName,
        detail: `申请执行阶段「${execution.name}」出口 Gate 放行。审批实例：${instance.id}`,
      },
    });
    return { gate: pendingGate, approvalInstanceId: instance.id };
  });

  return result;
};
