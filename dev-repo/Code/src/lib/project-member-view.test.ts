import { describe, expect, it } from "vitest";

import { serializeProjectMember } from "@/lib/project-member-view";

describe("project member view", () => {
  it("shows every current valid account role instead of a stale membership snapshot", () => {
    const result = serializeProjectMember({
      id: "member-1",
      projectId: "project-1",
      accountId: "account-1",
      roleName: "旧角色",
      personName: "旧名称",
      createdAt: new Date("2026-08-04T00:00:00.000Z"),
      updatedAt: new Date("2026-08-04T01:00:00.000Z"),
      account: {
        displayName: "张三",
        assignedRoleNames: JSON.stringify(["项目经理", "开发", "已删除角色"]),
      },
    }, new Set(["项目经理", "开发"]));

    expect(result.personName).toBe("张三");
    expect(result.roleNames).toEqual(["项目经理", "开发"]);
    expect(result.roleName).toBe("项目经理、开发");
  });
});
