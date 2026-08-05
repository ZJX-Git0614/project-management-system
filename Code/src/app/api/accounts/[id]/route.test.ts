import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  userHasPermission: vi.fn(),
  replaceGanttOwnerMember: vi.fn(),
  syncRoleConfigPersonsFromAccounts: vi.fn(),
  userAccountFindUnique: vi.fn(),
  roleConfigCount: vi.fn(),
  projectMemberFindMany: vi.fn(),
  projectMemberFindFirst: vi.fn(),
  projectMemberDeleteMany: vi.fn(),
  projectMemberUpdateMany: vi.fn(),
  userAccountUpdate: vi.fn(),
  operationHistoryCreateMany: vi.fn(),
  adminAuditLogCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  userHasPermission: mocks.userHasPermission,
}));
vi.mock("@/lib/gantt-owner-service", () => ({ replaceGanttOwnerMember: mocks.replaceGanttOwnerMember }));
vi.mock("@/lib/role-persons", () => ({
  syncRoleConfigPersonsFromAccounts: mocks.syncRoleConfigPersonsFromAccounts,
}));

const tx = {
  userAccount: { update: mocks.userAccountUpdate },
  projectMember: {
    findFirst: mocks.projectMemberFindFirst,
    deleteMany: mocks.projectMemberDeleteMany,
    updateMany: mocks.projectMemberUpdateMany,
  },
  operationHistory: { createMany: mocks.operationHistoryCreateMany },
  adminAuditLog: { create: mocks.adminAuditLogCreate },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    userAccount: { findUnique: mocks.userAccountFindUnique },
    roleConfig: { count: mocks.roleConfigCount },
    projectMember: { findMany: mocks.projectMemberFindMany },
    $transaction: mocks.transaction,
  },
}));

describe("PUT /api/accounts/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUser.mockResolvedValue({ displayName: "管理员", assignedRoleNames: ["管理员"] });
    mocks.userHasPermission.mockResolvedValue(true);
    mocks.userAccountFindUnique.mockResolvedValue({
      id: "account-1",
      displayName: "张三",
      assignedRoleNames: JSON.stringify(["项目经理", "开发"]),
    });
    mocks.roleConfigCount.mockResolvedValue(1);
    mocks.projectMemberFindMany.mockResolvedValue([
      { id: "member-manager", projectId: "project-1", accountId: "account-1", personName: "张三", roleName: "项目经理", project: { name: "项目 A" } },
      { id: "member-developer", projectId: "project-1", accountId: "account-1", personName: "张三", roleName: "开发", project: { name: "项目 A" } },
    ]);
    mocks.projectMemberFindFirst.mockResolvedValue({ id: "member-developer", personName: "张三" });
    mocks.userAccountUpdate.mockResolvedValue({
      id: "account-1",
      username: "zhangsan",
      displayName: "张三",
      enabled: true,
      assignedRoleNames: JSON.stringify(["开发"]),
      passwordResetRequired: false,
      createdAt: new Date("2026-08-04T00:00:00.000Z"),
    });
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
  });

  it("keeps the unique project membership and refreshes its role snapshot", async () => {
    mocks.projectMemberFindMany.mockResolvedValue([
      { id: "member-manager", projectId: "project-1", accountId: "account-1", personName: "张三", roleName: "项目经理", project: { name: "项目 A" } },
    ]);
    const { PUT } = await import("./route");
    const request = new Request("http://localhost/api/accounts/account-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedRoleNames: ["开发"], confirmRoleChange: true }),
    });

    const response = await PUT(request as never, { params: Promise.resolve({ id: "account-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.replaceGanttOwnerMember).not.toHaveBeenCalled();
    expect(mocks.projectMemberDeleteMany).not.toHaveBeenCalled();
    expect(mocks.projectMemberUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["member-manager"] } },
      data: { accountId: "account-1", personName: "张三", roleName: "开发" },
    });
  });

  it("rejects account changes without account-management edit permission", async () => {
    mocks.userHasPermission.mockResolvedValue(false);
    const { PUT } = await import("./route");
    const request = new Request("http://localhost/api/accounts/account-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    const response = await PUT(request as never, { params: Promise.resolve({ id: "account-1" }) });

    expect(response.status).toBe(403);
    expect(mocks.userAccountFindUnique).not.toHaveBeenCalled();
  });
});
