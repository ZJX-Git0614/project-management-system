import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  userHasPermission: vi.fn(),
  hasProjectAccess: vi.fn(),
  forbidden: vi.fn(() => new Response(null, { status: 403 })),
  unauthorizedFromRequest: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/server-auth", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  userHasPermission: mocks.userHasPermission,
}));

vi.mock("@/lib/project-access", () => ({
  hasProjectAccess: mocks.hasProjectAccess,
}));

vi.mock("@/lib/api-utils", () => ({
  forbidden: mocks.forbidden,
  unauthorizedFromRequest: mocks.unauthorizedFromRequest,
}));

const user = {
  userId: "user-1",
  username: "member",
  displayName: "项目成员",
  assignedRoleNames: ["项目成员"],
  assistantAccessMode: "REQUEST_APPROVAL" as const,
};

describe("project authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUser.mockResolvedValue(user);
    mocks.userHasPermission.mockResolvedValue(true);
    mocks.hasProjectAccess.mockResolvedValue(true);
  });

  it("requires both the global permission and project membership", async () => {
    const { requireProjectPermission } = await import("@/lib/project-authorization");

    await expect(requireProjectPermission(new Request("http://localhost") as never, "project-1", "project-gantt:view"))
      .resolves.toBe(user);
    expect(mocks.userHasPermission).toHaveBeenCalledWith(user, "project-gantt:view");
    expect(mocks.hasProjectAccess).toHaveBeenCalledWith(user, "project-1");
  });

  it("rejects a project member check even when the global permission is valid", async () => {
    mocks.hasProjectAccess.mockResolvedValue(false);
    const { requireProjectPermission } = await import("@/lib/project-authorization");

    const result = await requireProjectPermission(new Request("http://localhost") as never, "project-1", "project-gantt:view");

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it("rejects unauthenticated requests before querying permissions or membership", async () => {
    mocks.getAuthenticatedUser.mockResolvedValue(null);
    const { requireProjectPermission } = await import("@/lib/project-authorization");

    const result = await requireProjectPermission(new Request("http://localhost") as never, "project-1", "project-gantt:view");

    expect((result as Response).status).toBe(401);
    expect(mocks.userHasPermission).not.toHaveBeenCalled();
    expect(mocks.hasProjectAccess).not.toHaveBeenCalled();
  });

  it("supports access-only routes such as project-scoped history reads", async () => {
    const { authorizeProjectAccess } = await import("@/lib/project-authorization");

    await expect(authorizeProjectAccess(user, "project-1"))
      .resolves.toBeNull();
    expect(mocks.userHasPermission).not.toHaveBeenCalled();
  });
});
