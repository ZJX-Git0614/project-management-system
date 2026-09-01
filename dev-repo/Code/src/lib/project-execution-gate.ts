import { createHash } from "node:crypto";

import type { Prisma, ProjectExecutionGate } from "@prisma/client";

import { resolveProjectExecutionScope, type ProjectExecutionScopeTask } from "@/lib/project-execution";

export const EXECUTION_GATE_STATUSES = ["DRAFT", "READY", "PENDING_APPROVAL", "APPROVED", "REJECTED", "STALE"] as const;
export type ProjectExecutionGateStatus = (typeof EXECUTION_GATE_STATUSES)[number];

export type ExecutionGateCriterion = {
  key: "LEAF_TASKS" | "MATTERS" | "HIGH_RISKS";
  type: "TASK_COMPLETION" | "MATTER_CLEARANCE" | "RISK_CLEARANCE";
  required: boolean;
  status: "PASSED" | "FAILED";
  summary: string;
  detail: string;
  sortOrder: number;
};

export type ExecutionGateEvaluation = {
  executionId: string;
  projectId: string;
  ganttRevision: number;
  rangeHash: string;
  passed: boolean;
  criteria: ExecutionGateCriterion[];
  snapshotHash: string;
};

export type ExecutionGateEvaluationInput = {
  projectId: string;
  executionId: string;
  ganttRevision: number;
  links: Array<{ ganttTaskId: string; relationType: string }>;
  tasks: ProjectExecutionScopeTask[];
  matters: Array<{ id: string; status: string; dueDate?: string; ganttTaskIds: string[] }>;
  risks: Array<{ id: string; level: string; status: string; ganttTaskIds: string[] }>;
};

export const evaluateProjectExecutionGate = (input: ExecutionGateEvaluationInput): ExecutionGateEvaluation => {
  const scope = resolveProjectExecutionScope(input.links, input.tasks);
  const effectiveTaskIds = new Set(scope.effectiveTaskIds);
  const scopedMatters = input.matters.filter((matter) => matter.ganttTaskIds.some((taskId) => effectiveTaskIds.has(taskId)));
  const scopedRisks = input.risks.filter((risk) => risk.ganttTaskIds.some((taskId) => effectiveTaskIds.has(taskId)));
  const incompleteTasks = scope.effectiveTasks.filter((task) => task.progress < 100);
  const unfinishedMatters = scopedMatters.filter((matter) => matter.status !== "DONE");
  const openHighRisks = scopedRisks.filter((risk) => risk.level === "高" && risk.status !== "已关闭");
  const criteria: ExecutionGateCriterion[] = [
    {
      key: "LEAF_TASKS",
      type: "TASK_COMPLETION",
      required: true,
      status: scope.effectiveTasks.length > 0 && incompleteTasks.length === 0 ? "PASSED" : "FAILED",
      summary: scope.effectiveTasks.length === 0
        ? "阶段尚未关联有效的 WBS 末级任务"
        : incompleteTasks.length === 0
          ? `范围内 ${scope.effectiveTasks.length} 项末级任务均已完成`
          : `${incompleteTasks.length}/${scope.effectiveTasks.length} 项末级任务尚未完成`,
      detail: incompleteTasks.map((task) => `${task.taskCode} · ${task.taskName}`).join("\n"),
      sortOrder: 1,
    },
    {
      key: "MATTERS",
      type: "MATTER_CLEARANCE",
      required: true,
      status: unfinishedMatters.length === 0 ? "PASSED" : "FAILED",
      summary: unfinishedMatters.length === 0 ? "关联事项均已完成" : `${unfinishedMatters.length} 项关联事项尚未完成`,
      detail: unfinishedMatters.map((matter) => matter.id).join("\n"),
      sortOrder: 2,
    },
    {
      key: "HIGH_RISKS",
      type: "RISK_CLEARANCE",
      required: true,
      status: openHighRisks.length === 0 ? "PASSED" : "FAILED",
      summary: openHighRisks.length === 0 ? "不存在未关闭高风险" : `${openHighRisks.length} 项高风险尚未关闭`,
      detail: openHighRisks.map((risk) => risk.id).join("\n"),
      sortOrder: 3,
    },
  ];
  const snapshot = {
    executionId: input.executionId,
    ganttRevision: input.ganttRevision,
    rangeHash: scope.rangeHash,
    effectiveTaskIds: scope.effectiveTaskIds.slice().sort(),
    criteria,
  };
  return {
    executionId: input.executionId,
    projectId: input.projectId,
    ganttRevision: input.ganttRevision,
    rangeHash: scope.rangeHash,
    passed: criteria.every((criterion) => !criterion.required || criterion.status === "PASSED"),
    criteria,
    snapshotHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
  };
};

export const serializeProjectExecutionGate = (gate: ProjectExecutionGate) => ({
  id: gate.id,
  projectId: gate.projectId,
  executionId: gate.executionId,
  status: gate.status,
  ganttRevision: gate.ganttRevision,
  rangeHash: gate.rangeHash,
  requestNote: gate.requestNote,
  approvalInstanceId: gate.approvalInstanceId,
  requestedAt: gate.requestedAt?.toISOString() ?? null,
  approvedAt: gate.approvedAt?.toISOString() ?? null,
  decisionSummary: gate.decisionSummary,
  createdAt: gate.createdAt.toISOString(),
  updatedAt: gate.updatedAt.toISOString(),
});

export const gateCriteriaCreateData = (criteria: ExecutionGateCriterion[]): Prisma.ProjectExecutionGateCriterionCreateManyGateInput[] => (
  criteria.map((criterion) => ({
    criterionKey: criterion.key,
    criterionType: criterion.type,
    required: criterion.required,
    status: criterion.status,
    summary: criterion.summary,
    detail: criterion.detail,
    sortOrder: criterion.sortOrder,
  }))
);
