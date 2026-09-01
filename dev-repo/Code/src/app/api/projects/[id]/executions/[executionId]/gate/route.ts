import { NextRequest } from "next/server";

import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { startApprovalWorkflow } from "@/lib/approval-workflow-server";
import {
  APPROVAL_BUSINESS_TYPES,
  approvalBusinessIdForProjectExecutionExitGate,
} from "@/lib/approval-workflow";
import { gateCriteriaCreateData, serializeProjectExecutionGate } from "@/lib/project-execution-gate";
import { loadProjectExecutionGateEvaluation } from "@/lib/project-execution-gate-service";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

type RouteContext = { params: Promise<{ id: string; executionId: string }> };

const serializeEvaluation = (evaluation: Awaited<ReturnType<typeof loadProjectExecutionGateEvaluation>>["evaluation"]) => ({
  executionId: evaluation.executionId,
  projectId: evaluation.projectId,
  ganttRevision: evaluation.ganttRevision,
  rangeHash: evaluation.rangeHash,
  snapshotHash: evaluation.snapshotHash,
  passed: evaluation.passed,
  criteria: evaluation.criteria,
});

export async function GET(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:view")) return forbidden();
  const { id: projectId, executionId } = await params;
  try {
    const loaded = await prisma.$transaction((tx) => loadProjectExecutionGateEvaluation(tx, projectId, executionId));
    const gates = await prisma.projectExecutionGate.findMany({
      where: { projectId, executionId },
      orderBy: { createdAt: "desc" },
      include: { criteria: { orderBy: { sortOrder: "asc" } } },
      take: 20,
    });
    return ok({
      execution: { id: loaded.execution.id, name: loaded.execution.name, status: loaded.execution.status },
      evaluation: serializeEvaluation(loaded.evaluation),
      gates: gates.map((gate) => ({
        ...serializeProjectExecutionGate(gate),
        criteria: gate.criteria.map((criterion) => ({
          key: criterion.criterionKey,
          type: criterion.criterionType,
          required: criterion.required,
          status: criterion.status,
          summary: criterion.summary,
          detail: criterion.detail,
          sortOrder: criterion.sortOrder,
        })),
      })),
    });
  } catch (error) {
    return err(error instanceof Error ? error.message : "无法评估阶段出口 Gate", 400);
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-execution:gate-request")) return forbidden();
  const { id: projectId, executionId } = await params;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const requestNote = String(body.requestNote || "").trim();
  if (!requestNote) return err("请填写 Gate 放行申请说明");
  if (requestNote.length > 2000) return err("申请说明不能超过 2000 个字符");

  try {
    const result = await prisma.$transaction(async (tx) => {
      const { project, execution, evaluation } = await loadProjectExecutionGateEvaluation(tx, projectId, executionId);
      if (execution.status === "COMPLETED" || execution.status === "ARCHIVED") throw new Error("已完成或已归档的阶段不能重复申请出口 Gate");
      if (!evaluation.passed) throw new Error(evaluation.criteria.filter((criterion) => criterion.required && criterion.status !== "PASSED").map((criterion) => criterion.summary).join("\n"));
      const gate = await tx.projectExecutionGate.create({
        data: {
          projectId,
          executionId,
          status: "READY",
          ganttRevision: evaluation.ganttRevision,
          rangeHash: evaluation.rangeHash,
          snapshotJson: JSON.stringify(serializeEvaluation(evaluation)),
          requestNote,
          criteria: { createMany: { data: gateCriteriaCreateData(evaluation.criteria) } },
        },
      });
      return { project, execution, evaluation, gate };
    });
    const instance = await startApprovalWorkflow({
      projectId,
      businessType: APPROVAL_BUSINESS_TYPES.PROJECT_EXECUTION_EXIT_GATE,
      businessId: approvalBusinessIdForProjectExecutionExitGate(projectId, executionId),
      requester: user,
      payload: {
        gateId: result.gate.id,
        executionId,
        executionName: result.execution.name,
        ganttRevision: result.evaluation.ganttRevision,
        rangeHash: result.evaluation.rangeHash,
        snapshotHash: result.evaluation.snapshotHash,
        requestNote,
      },
    });
    const gate = await prisma.projectExecutionGate.update({
      where: { id: result.gate.id },
      data: { status: "PENDING_APPROVAL", requestedAt: new Date(), approvalInstanceId: instance.id },
    });
    await prisma.operationHistory.create({
      data: {
        projectId,
        entityType: "PROJECT_EXECUTION_GATE",
        entityId: gate.id,
        actionType: "REQUEST",
        operator: user.displayName,
        detail: `申请执行阶段「${result.execution.name}」出口 Gate 放行。审批实例：${instance.id}`,
      },
    });
    return ok({ gate: serializeProjectExecutionGate(gate), approvalInstanceId: instance.id }, 201);
  } catch (error) {
    return err(error instanceof Error ? error.message : "Gate 放行申请失败", 400);
  }
}
