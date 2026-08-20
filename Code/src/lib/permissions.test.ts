import { describe, expect, it } from "vitest";

import { hasPermission, normalizePermissionTree } from "@/lib/permissions";

describe("permission tree migrations", () => {
  it("migrates legacy overview permissions to the project WBS page", () => {
    const tree = normalizePermissionTree({
      "只读角色": ["project-progress", "overview", "overview:view"],
    });

    expect(tree["只读角色"]).toEqual(expect.arrayContaining([
      "project-progress",
      "project-wbs",
      "project-gantt:view",
    ]));
    expect(tree["只读角色"]).not.toContain("overview");
    expect(hasPermission(tree, "只读角色", "project-gantt:view")).toBe(true);
  });

  it("keeps project managers able to process workflows assigned by project role", () => {
    const tree = normalizePermissionTree({
      "项目经理": [],
    });

    expect(tree["项目经理"]).toEqual(expect.arrayContaining([
      "approval-center",
      "approval-center:view",
      "approval-center:process",
    ]));
  });
});
