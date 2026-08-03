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
});
