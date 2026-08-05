import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  userHasPermission: vi.fn(),
  userAccountFindUnique: vi.fn(),
  userAccountCreate: vi.fn(),
  roleConfigCount: vi.fn(),
  syncRoleConfigPersonsFromAccounts: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getUserFromRequest: vi.fn(),
  hashPassword: vi.fn(() => "hashed-password"),
}));
vi.mock("@/lib/server-auth", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  userHasPermission: mocks.userHasPermission,
}));
vi.mock("@/lib/role-persons", () => ({
  syncRoleConfigPersonsFromAccounts: mocks.syncRoleConfigPersonsFromAccounts,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    userAccount: {
      findUnique: mocks.userAccountFindUnique,
      create: mocks.userAccountCreate,
    },
    roleConfig: { count: mocks.roleConfigCount },
  },
}));

describe("POST /api/accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUser.mockResolvedValue({ displayName: "管理员", assignedRoleNames: ["管理员"] });
    mocks.userHasPermission.mockResolvedValue(true);
  });

  it("rejects account creation without account-management edit permission", async () => {
    mocks.userHasPermission.mockResolvedValue(false);
    const { POST } = await import("./route");
    const request = new Request("http://localhost/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "tester", password: "secret", displayName: "测试员" }),
    });

    const response = await POST(request as never);

    expect(response.status).toBe(403);
    expect(mocks.userAccountCreate).not.toHaveBeenCalled();
  });
});
