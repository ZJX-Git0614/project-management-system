import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  userHasPermission: vi.fn(),
  roleConfigFindUnique: vi.fn(),
  roleConfigCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getUserFromRequest: vi.fn() }));
vi.mock("@/lib/server-auth", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  userHasPermission: mocks.userHasPermission,
}));
vi.mock("@/lib/role-persons", () => ({ buildPersonsByRoleFromAccounts: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    roleConfig: {
      findUnique: mocks.roleConfigFindUnique,
      create: mocks.roleConfigCreate,
    },
  },
}));

describe("POST /api/role-config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUser.mockResolvedValue({ displayName: "管理员", assignedRoleNames: ["管理员"] });
    mocks.userHasPermission.mockResolvedValue(true);
  });

  it("rejects role creation without role-config edit permission", async () => {
    mocks.userHasPermission.mockResolvedValue(false);
    const { POST } = await import("./route");
    const request = new Request("http://localhost/api/role-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roleName: "测试角色" }),
    });

    const response = await POST(request as never);

    expect(response.status).toBe(403);
    expect(mocks.roleConfigCreate).not.toHaveBeenCalled();
  });

  it("never allows callers to create a system preset role", async () => {
    const { POST } = await import("./route");
    const request = new Request("http://localhost/api/role-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roleName: "伪预置角色", systemPreset: true }),
    });

    const response = await POST(request as never);

    expect(response.status).toBe(403);
    expect(mocks.roleConfigCreate).not.toHaveBeenCalled();
  });
});
