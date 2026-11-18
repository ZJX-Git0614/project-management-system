import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    projectExecutionGate: { create: vi.fn(), update: vi.fn() },
    operationHistory: { create: vi.fn() },
  };
  return {
    tx,
    transaction: vi.fn(),
    requireProjectPermission: vi.fn(),
    startApprovalWorkflow: vi.fn(),
    loadProjectExecutionGateEvaluation: vi.fn(),
    gateCriteriaCreateData: vi.fn(),
    serializeProjectExecutionGate: vi.fn(),
  };
});

vi.mock("@/lib/project-authorization", () => ({
  requireProjectPermission: mocks.requireProjectPermission,
  isProjectAuthorizationResponse: (value: unknown) => value instanceof Response,
}));
vi.mock("@/lib/approval-workflow-server", () => ({
  startApprovalWorkflow: mocks.startApprovalWorkflow,
}));
vi.mock("@/lib/project-execution-gate", () => ({
  gateCriteriaCreateData: mocks.gateCriteriaCreateData,
  serializeProjectExecutionGate: mocks.serializeProjectExecutionGate,
}));
vi.mock("@/lib/project-execution-gate-service", () => ({
  loadProjectExecutionGateEvaluation: mocks.loadProjectExecutionGateEvaluation,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    projectExecutionGate: { findMany: vi.fn() },
  },
}));

const user = {
  userId: "user-1",
  displayName: "项目经理",
  assignedRoleNames: ["项目经理"],
  assistantAccessMode: "REQUEST_APPROVAL" as const,
};

const evaluation = {
  executionId: "execution-1",
  projectId: "project-1",
  ganttRevision: 8,
  rangeHash: "range-hash",
  snapshotHash: "snapshot-hash",
  passed: true,
  criteria: [],
};

const createGate = (status: string, approvalInstanceId: string | null = null) => ({
  id: "gate-1",
  projectId: "project-1",
  executionId: "execution-1",
  status,
  ganttRevision: 8,
  rangeHash: "range-hash",
  requestNote: "阶段已完成，请审批放行",
  approvalInstanceId,
  requestedAt: null,
  approvedAt: null,
  decisionSummary: "",
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
});

describe("POST /api/projects/:id/executions/:executionId/gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireProjectPermission.mockResolvedValue(user);
    mocks.transaction.mockImplementation(async (callback) => callback(mocks.tx));
    mocks.loadProjectExecutionGateEvaluation.mockResolvedValue({
      project: { id: "project-1", name: "示例项目", status: "IN_PROGRESS", ganttRevision: 8 },
      execution: { id: "execution-1", name: "安装阶段", status: "IN_PROGRESS" },
      evaluation,
    });
    mocks.gateCriteriaCreateData.mockReturnValue([]);
    mocks.tx.projectExecutionGate.create.mockResolvedValue(createGate("READY"));
    mocks.tx.projectExecutionGate.update.mockResolvedValue(createGate("PENDING_APPROVAL", "approval-1"));
    mocks.tx.operationHistory.create.mockResolvedValue({});
    mocks.startApprovalWorkflow.mockResolvedValue({ id: "approval-1" });
    mocks.serializeProjectExecutionGate.mockImplementation((gate) => ({ id: gate.id, status: gate.status }));
  });

  it("creates the gate and approval in one transaction", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://localhost/api/projects/project-1/executions/execution-1/gate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestNote: "阶段已完成，请审批放行" }),
    }), { params: Promise.resolve({ id: "project-1", executionId: "execution-1" }) });

    expect(response.status).toBe(201);
    expect(mocks.startApprovalWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      businessId: "project-1:execution-exit-gate:execution-1",
      db: mocks.tx,
    }));
    expect(mocks.tx.projectExecutionGate.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "gate-1" },
      data: expect.objectContaining({ status: "PENDING_APPROVAL", approvalInstanceId: "approval-1" }),
    }));
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { gate: { id: "gate-1", status: "PENDING_APPROVAL" }, approvalInstanceId: "approval-1" },
    });
  });

  it("does not run post-approval updates when approval creation fails", async () => {
    mocks.startApprovalWorkflow.mockRejectedValue(new Error("审批流程未启用"));
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://localhost/api/projects/project-1/executions/execution-1/gate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestNote: "阶段已完成，请审批放行" }),
    }), { params: Promise.resolve({ id: "project-1", executionId: "execution-1" }) });

    expect(response.status).toBe(400);
    expect(mocks.tx.projectExecutionGate.update).not.toHaveBeenCalled();
    expect(mocks.tx.operationHistory.create).not.toHaveBeenCalled();
  });
});
