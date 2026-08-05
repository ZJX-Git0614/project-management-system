import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    projectMember: { delete: vi.fn() },
    operationHistory: { create: vi.fn() },
  };
  return {
    getAuthenticatedUser: vi.fn(),
    userHasPermission: vi.fn(),
    replaceGanttOwnerMember: vi.fn(),
    projectFindUnique: vi.fn(),
    projectMemberFindFirst: vi.fn(),
    projectMemberFindMany: vi.fn(),
    projectGanttTaskFindMany: vi.fn(),
    weeklyItemFindMany: vi.fn(),
    riskRegisterItemFindMany: vi.fn(),
    transaction: vi.fn(),
    tx,
  };
});

vi.mock("@/lib/server-auth", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  userHasPermission: mocks.userHasPermission,
}));
vi.mock("@/lib/gantt-owner-service", () => ({
  replaceGanttOwnerMember: mocks.replaceGanttOwnerMember,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: mocks.projectFindUnique },
    projectMember: {
      findFirst: mocks.projectMemberFindFirst,
      findMany: mocks.projectMemberFindMany,
    },
    projectGanttTask: { findMany: mocks.projectGanttTaskFindMany },
    weeklyItem: { findMany: mocks.weeklyItemFindMany },
    riskRegisterItem: { findMany: mocks.riskRegisterItemFindMany },
    $transaction: mocks.transaction,
  },
}));

const params = { params: Promise.resolve({ id: "project-1", memberId: "member-1" }) };

describe("project member removal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUser.mockResolvedValue({ displayName: "管理员" });
    mocks.userHasPermission.mockResolvedValue(true);
    mocks.projectFindUnique.mockResolvedValue({ id: "project-1", status: "IN_PROGRESS" });
    mocks.projectMemberFindFirst.mockResolvedValue({
      id: "member-1",
      projectId: "project-1",
      accountId: "account-1",
      personName: "张三",
      roleName: "项目成员",
    });
    mocks.projectMemberFindMany.mockResolvedValue([
      { id: "member-2", accountId: "account-2", personName: "李四", roleName: "项目成员" },
    ]);
    mocks.projectGanttTaskFindMany.mockResolvedValue([
      { id: "task-1", taskCode: "Task1.1", taskName: "设计" },
    ]);
    mocks.weeklyItemFindMany.mockResolvedValue([]);
    mocks.riskRegisterItemFindMany.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (callback) => callback(mocks.tx));
    mocks.tx.projectMember.delete.mockResolvedValue({});
    mocks.tx.operationHistory.create.mockResolvedValue({});
    mocks.replaceGanttOwnerMember.mockResolvedValue({});
  });

  it("previews the tasks and replacement candidates before deletion", async () => {
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/projects/project-1/members/member-1"), params);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.totalAssignments).toBe(1);
    expect(payload.data.tasks).toEqual([{ id: "task-1", taskCode: "Task1.1", taskName: "设计" }]);
    expect(payload.data.replacementCandidates[0].personName).toBe("李四");
  });

  it("refuses to delete an assigned member until a handoff choice is confirmed", async () => {
    const { DELETE } = await import("./route");
    const response = await DELETE(new NextRequest("http://localhost/api/projects/project-1/members/member-1", { method: "DELETE" }), params);

    expect(response.status).toBe(409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("allows the explicit unassigned choice and removes the member transactionally", async () => {
    const { DELETE } = await import("./route");
    const response = await DELETE(new NextRequest(
      "http://localhost/api/projects/project-1/members/member-1?confirmed=true&replacementMemberId=__UNASSIGNED__",
      { method: "DELETE" },
    ), params);

    expect(response.status).toBe(200);
    expect(mocks.replaceGanttOwnerMember).toHaveBeenCalledWith(expect.objectContaining({
      removedMemberId: "member-1",
      replacementMemberId: null,
      replacementPersonName: null,
    }));
    expect(mocks.tx.projectMember.delete).toHaveBeenCalledWith({ where: { id: "member-1" } });
  });
});
