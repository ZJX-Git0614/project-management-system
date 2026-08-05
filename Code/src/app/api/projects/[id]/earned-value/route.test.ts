import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureMutableProject: vi.fn(),
  getAuthenticatedUser: vi.fn(),
  userHasPermission: vi.fn(),
  projectGanttTaskCount: vi.fn(),
  projectGanttTaskUpdate: vi.fn(),
  projectBudgetItemCount: vi.fn(),
  operationHistoryCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getUserFromRequest: vi.fn() }));
vi.mock("@/lib/server-auth", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  userHasPermission: mocks.userHasPermission,
}));
vi.mock("@/lib/api-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-utils")>();
  return { ...actual, ensureMutableProject: mocks.ensureMutableProject };
});
vi.mock("@/lib/gantt-task-service", () => ({
  getOrderedGanttTasks: vi.fn(),
  serializeGanttTaskList: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    projectGanttTask: {
      count: mocks.projectGanttTaskCount,
      update: mocks.projectGanttTaskUpdate,
    },
    projectBudgetItem: { count: mocks.projectBudgetItemCount },
    operationHistory: { create: mocks.operationHistoryCreate },
    $transaction: mocks.transaction,
  },
}));

describe("PUT /api/projects/:id/earned-value", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUser.mockResolvedValue({ displayName: "管理员", assignedRoleNames: ["管理员"] });
    mocks.userHasPermission.mockResolvedValue(true);
    mocks.ensureMutableProject.mockResolvedValue(null);
    mocks.projectGanttTaskCount.mockResolvedValue(1);
    mocks.projectBudgetItemCount.mockResolvedValue(1);
    mocks.projectGanttTaskUpdate.mockReturnValue({ operation: "update-task" });
    mocks.operationHistoryCreate.mockReturnValue({ operation: "create-history" });
    mocks.transaction.mockResolvedValue([]);
  });

  it("updates cost fields but never overwrites work hours owned by WBS", async () => {
    const { PUT } = await import("./route");
    const request = new Request("http://localhost/api/projects/project-1/earned-value", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: [{
          taskId: "task-1",
          budgetItemId: "budget-1",
          budgetAtCompletion: 1200,
          actualCost: 430,
          estimatedWorkHours: 999,
          actualWorkHours: 888,
        }],
      }),
    });

    const response = await PUT(request as never, { params: Promise.resolve({ id: "project-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.projectGanttTaskUpdate).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: {
        budgetAtCompletion: 1200,
        actualCost: 430,
        budgetItemId: "budget-1",
      },
    });
    expect(mocks.projectGanttTaskUpdate.mock.calls[0][0].data).not.toHaveProperty("estimatedWorkHours");
    expect(mocks.projectGanttTaskUpdate.mock.calls[0][0].data).not.toHaveProperty("actualWorkHours");
  });

  it("rejects writes without earned-value edit permission", async () => {
    mocks.userHasPermission.mockResolvedValue(false);
    const { PUT } = await import("./route");
    const request = new Request("http://localhost/api/projects/project-1/earned-value", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [] }),
    });

    const response = await PUT(request as never, { params: Promise.resolve({ id: "project-1" }) });

    expect(response.status).toBe(403);
    expect(mocks.ensureMutableProject).not.toHaveBeenCalled();
  });
});
