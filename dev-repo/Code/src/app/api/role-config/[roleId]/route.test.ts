import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  userHasPermission: vi.fn(),
  replaceGanttOwnerMember: vi.fn(),
  syncRoleConfigPersonsFromAccounts: vi.fn(),
  roleConfigFindUnique: vi.fn(),
  accountFindMany: vi.fn(),
  memberFindMany: vi.fn(),
  transaction: vi.fn(),
  txAccountFindUnique: vi.fn(),
  txAccountUpdate: vi.fn(),
  txMemberUpdateMany: vi.fn(),
  txMemberFindFirst: vi.fn(),
  txMemberDeleteMany: vi.fn(),
  txPermissionFindUnique: vi.fn(),
  txPermissionUpdate: vi.fn(),
  txHistoryCreateMany: vi.fn(),
  txAuditCreate: vi.fn(),
  txRoleUpdate: vi.fn(),
  txRoleDelete: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getUserFromRequest: vi.fn() }));
vi.mock("@/lib/server-auth", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  userHasPermission: mocks.userHasPermission,
}));
vi.mock("@/lib/gantt-owner-service", () => ({ replaceGanttOwnerMember: mocks.replaceGanttOwnerMember }));
vi.mock("@/lib/role-persons", () => ({
  syncRoleConfigPersonsFromAccounts: mocks.syncRoleConfigPersonsFromAccounts,
}));

const tx = {
  userAccount: {
    findUnique: mocks.txAccountFindUnique,
    update: mocks.txAccountUpdate,
  },
  projectMember: {
    updateMany: mocks.txMemberUpdateMany,
    findFirst: mocks.txMemberFindFirst,
    deleteMany: mocks.txMemberDeleteMany,
  },
  permissionTree: {
    findUnique: mocks.txPermissionFindUnique,
    update: mocks.txPermissionUpdate,
  },
  operationHistory: { createMany: mocks.txHistoryCreateMany },
  adminAuditLog: { create: mocks.txAuditCreate },
  roleConfig: {
    update: mocks.txRoleUpdate,
    delete: mocks.txRoleDelete,
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    roleConfig: { findUnique: mocks.roleConfigFindUnique },
    userAccount: { findMany: mocks.accountFindMany },
    projectMember: { findMany: mocks.memberFindMany },
    $transaction: mocks.transaction,
  },
}));

const roleConfig = {
  id: "role-1",
  roleName: "开发",
  allowMultiple: true,
  systemPreset: false,
  persons: "[]",
  createdAt: new Date("2026-08-04T00:00:00.000Z"),
  updatedAt: new Date("2026-08-04T00:00:00.000Z"),
};

describe("/api/role-config/:roleId write integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUser.mockResolvedValue({ displayName: "管理员", assignedRoleNames: ["管理员"] });
    mocks.userHasPermission.mockResolvedValue(true);
    mocks.roleConfigFindUnique.mockImplementation(({ where }) => where.id ? roleConfig : null);
    mocks.accountFindMany.mockResolvedValue([]);
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.txPermissionFindUnique.mockResolvedValue(null);
    mocks.txRoleUpdate.mockImplementation(async ({ data }) => ({ ...roleConfig, ...data, updatedAt: new Date("2026-08-04T01:00:00.000Z") }));
    mocks.txRoleDelete.mockResolvedValue(roleConfig);
  });

  it("rejects writes without role-config edit permission", async () => {
    mocks.userHasPermission.mockResolvedValue(false);
    const { PUT } = await import("./route");
    const request = new Request("http://localhost/api/role-config/role-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowMultiple: false }),
    });

    const response = await PUT(request as never, { params: Promise.resolve({ roleId: "role-1" }) });

    expect(response.status).toBe(403);
    expect(mocks.roleConfigFindUnique).not.toHaveBeenCalled();
  });

  it("blocks renaming or deleting a system preset role", async () => {
    mocks.roleConfigFindUnique.mockResolvedValue({ ...roleConfig, systemPreset: true });
    const { PUT, DELETE } = await import("./route");
    const putRequest = new Request("http://localhost/api/role-config/role-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roleName: "新名称", confirmRoleChange: true }),
    });

    const putResponse = await PUT(putRequest as never, { params: Promise.resolve({ roleId: "role-1" }) });
    const deleteResponse = await DELETE(
      new NextRequest("http://localhost/api/role-config/role-1?confirmed=true", { method: "DELETE" }),
      { params: Promise.resolve({ roleId: "role-1" }) },
    );

    expect(putResponse.status).toBe(403);
    expect(deleteResponse.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("preserves malformed permission data during a role rename", async () => {
    mocks.txPermissionFindUnique.mockResolvedValue({ id: "default_tree", data: "{损坏" });
    const { PUT } = await import("./route");
    const request = new Request("http://localhost/api/role-config/role-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roleName: "研发", confirmRoleChange: true }),
    });

    const response = await PUT(request as never, { params: Promise.resolve({ roleId: "role-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.txPermissionUpdate).not.toHaveBeenCalled();
  });

  it("propagates permission-tree database write failures", async () => {
    mocks.txPermissionFindUnique.mockResolvedValue({ id: "default_tree", data: JSON.stringify({ 开发: ["project-list:view"] }) });
    mocks.txPermissionUpdate.mockRejectedValue(new Error("database write failed"));
    const { PUT } = await import("./route");
    const request = new Request("http://localhost/api/role-config/role-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roleName: "研发", confirmRoleChange: true }),
    });

    await expect(PUT(request as never, { params: Promise.resolve({ roleId: "role-1" }) }))
      .rejects.toThrow("database write failed");
  });

  it("keeps the project membership when the account still has another role", async () => {
    mocks.accountFindMany.mockResolvedValue([
      { id: "account-1", displayName: "张三", assignedRoleNames: JSON.stringify(["开发", "项目经理"]) },
    ]);
    mocks.memberFindMany.mockResolvedValue([
      {
        id: "member-developer",
        projectId: "project-1",
        accountId: "account-1",
        personName: "张三",
        project: { name: "项目 A" },
      },
    ]);
    const { DELETE } = await import("./route");
    const request = new NextRequest("http://localhost/api/role-config/role-1?confirmed=true", { method: "DELETE" });

    const response = await DELETE(request, { params: Promise.resolve({ roleId: "role-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.replaceGanttOwnerMember).not.toHaveBeenCalled();
    expect(mocks.txMemberDeleteMany).not.toHaveBeenCalled();
    expect(mocks.txMemberUpdateMany).toHaveBeenCalledWith({
      where: { id: "member-developer" },
      data: { roleName: "项目经理" },
    });
  });
});
