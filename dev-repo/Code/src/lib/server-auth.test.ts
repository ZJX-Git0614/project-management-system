import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PERMISSION_TREE } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  permissionTreeFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    permissionTree: { findUnique: mocks.permissionTreeFindUnique },
  },
}));

describe("userHasPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissionTreeFindUnique.mockResolvedValue({ data: JSON.stringify(DEFAULT_PERMISSION_TREE) });
  });

  it("shares one permission-tree lookup across checks for the same request user", async () => {
    const { userHasPermission } = await import("./server-auth");
    const user = {
      userId: "user-1",
      username: "member",
      displayName: "项目成员",
      assignedRoleNames: ["项目成员"],
      assistantAccessMode: "REQUEST_APPROVAL" as const,
    };

    const results = await Promise.all([
      userHasPermission(user, "project-info:view"),
      userHasPermission(user, "earned-value:view"),
      userHasPermission(user, "project-info:view"),
    ]);

    expect(results).toEqual([true, true, true]);
    expect(mocks.permissionTreeFindUnique).toHaveBeenCalledTimes(1);
  });
});
