import { describe, expect, it } from "vitest";

import {
  buildAccountRoleChangeConfirmation,
  buildAffectedProjects,
  diffRoleNames,
  normalizeRoleNames,
  parseRoleNames,
} from "@/lib/role-assignments";

describe("role assignments", () => {
  it("normalizes and parses multi-role assignments", () => {
    expect(normalizeRoleNames([" 项目经理 ", "开发", "项目经理", 1])).toEqual(["项目经理", "开发"]);
    expect(parseRoleNames('["项目经理","开发"]')).toEqual(["项目经理", "开发"]);
    expect(parseRoleNames("无效 JSON")).toEqual([]);
  });

  it("calculates added and removed roles", () => {
    expect(diffRoleNames(["项目经理", "开发"], ["开发", "测试"])).toEqual({
      addedRoleNames: ["测试"],
      removedRoleNames: ["项目经理"],
    });
  });

  it("groups removed project memberships and describes the synchronization impact", () => {
    const memberships = [
      { id: "member-1", projectId: "project-1", roleName: "项目经理", project: { name: "A 项目" } },
      { id: "member-2", projectId: "project-1", roleName: "开发", project: { name: "A 项目" } },
      { id: "member-3", projectId: "project-2", roleName: "项目经理", project: { name: "B 项目" } },
    ];

    expect(buildAffectedProjects(memberships, ["项目经理"])).toEqual([
      {
        projectId: "project-1",
        projectName: "A 项目",
        removedRoleNames: ["项目经理"],
        membershipIds: ["member-1"],
      },
      {
        projectId: "project-2",
        projectName: "B 项目",
        removedRoleNames: ["项目经理"],
        membershipIds: ["member-3"],
      },
    ]);

    const confirmation = buildAccountRoleChangeConfirmation({
      displayName: "张三",
      previousRoleNames: ["项目经理", "开发"],
      nextRoleNames: ["开发", "测试"],
      memberships,
    });
    expect(confirmation).toContain("新增角色：测试");
    expect(confirmation).toContain("移除角色：项目经理");
    expect(confirmation).toContain("《A 项目》：项目经理");
    expect(confirmation).toContain("《B 项目》：项目经理");
    expect(confirmation).toContain("全部角色取并集");
  });
});
