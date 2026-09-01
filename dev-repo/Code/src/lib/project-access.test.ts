import { describe, expect, it, vi } from "vitest";

import { hasProjectAccess } from "@/lib/project-access";

const member = {
  userId: "account-1",
  displayName: "项目成员",
  assignedRoleNames: ["项目成员"],
};

describe("project access", () => {
  it("lets administrators access projects without a membership lookup", async () => {
    const findFirst = vi.fn();
    const db = { projectMember: { findFirst } } as unknown as NonNullable<Parameters<typeof hasProjectAccess>[2]>;

    await expect(hasProjectAccess({ ...member, assignedRoleNames: ["管理员"] }, "project-1", db)).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("uses the stable account id with the legacy unambiguous-name fallback", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "member-1" });
    const db = { projectMember: { findFirst } } as unknown as NonNullable<Parameters<typeof hasProjectAccess>[2]>;

    await expect(hasProjectAccess(member, "project-1", db)).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        OR: [
          { accountId: "account-1" },
          { accountId: null, personName: "项目成员" },
        ],
      },
      select: { id: true },
    });
  });

  it("denies users who are not project members", async () => {
    const db = {
      projectMember: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as NonNullable<Parameters<typeof hasProjectAccess>[2]>;

    await expect(hasProjectAccess(member, "project-1", db)).resolves.toBe(false);
  });
});
