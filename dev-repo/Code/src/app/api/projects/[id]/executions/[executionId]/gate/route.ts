import { NextRequest } from "next/server";

import { err, ok } from "@/lib/api-utils";
import { serializeProjectExecutionGate } from "@/lib/project-execution-gate";
import { loadProjectExecutionGateEvaluation } from "@/lib/project-execution-gate-service";
import { prisma } from "@/lib/prisma";
import { requestExecutionGate } from "@/modules/execution";
import {
  isProjectAuthorizationResponse,
  requireProjectPermission,
} from "@/lib/project-authorization";

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
  const { id: projectId, executionId } = await params;
  const user = await requireProjectPermission(req, projectId, "project-gantt:view");
  if (isProjectAuthorizationResponse(user)) return user;
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
  const { id: projectId, executionId } = await params;
  const user = await requireProjectPermission(req, projectId, "project-execution:gate-request");
  if (isProjectAuthorizationResponse(user)) return user;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const requestNote = String(body.requestNote || "").trim();
  if (!requestNote) return err("请填写 Gate 放行申请说明");
  if (requestNote.length > 2000) return err("申请说明不能超过 2000 个字符");

  try {
    const result = await requestExecutionGate({
      projectId,
      executionId,
      requestNote,
      requester: user,
    });
    return ok({ gate: serializeProjectExecutionGate(result.gate), approvalInstanceId: result.approvalInstanceId }, 201);
  } catch (error) {
    return err(error instanceof Error ? error.message : "Gate 放行申请失败", 400);
  }
}
