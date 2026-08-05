import { describe, expect, it } from "vitest";

import {
  buildGanttOwnerIdentityIndex,
  buildGanttOwnerRollups,
  buildGanttUnassignedLeafTasksByParentId,
  getEffectiveGanttOwnerMemberId,
  planGanttLegacyOwnerBackfill,
  planGanttOwnerChange,
  planGanttOwnerHierarchyNormalization,
  type GanttOwnerTask,
} from "@/lib/gantt-owner-hierarchy";

const tasks: GanttOwnerTask[] = [
  { id: "root", parentId: null, ownerMemberId: "owner-a" },
  { id: "child-a", parentId: "root", ownerMemberId: "owner-a" },
  { id: "child-b", parentId: "root", ownerMemberId: "owner-a" },
  { id: "grandchild", parentId: "child-a", ownerMemberId: "owner-a" },
];

describe("gantt owner hierarchy", () => {
  it("propagates a parent owner to every descendant", () => {
    expect(planGanttOwnerChange(tasks, "root", "owner-b")).toEqual([
      { id: "root", ownerMemberId: "owner-b" },
      { id: "child-a", ownerMemberId: "owner-b" },
      { id: "child-b", ownerMemberId: "owner-b" },
      { id: "grandchild", ownerMemberId: "owner-b" },
    ]);
  });

  it("propagates an explicit unassigned choice to every descendant", () => {
    expect(planGanttOwnerChange(tasks, "root", null)).toEqual([
      { id: "root", ownerMemberId: null },
      { id: "child-a", ownerMemberId: null },
      { id: "child-b", ownerMemberId: null },
      { id: "grandchild", ownerMemberId: null },
    ]);
  });

  it("clears the stored parent owner when child branches have different owners", () => {
    expect(planGanttOwnerChange(tasks, "grandchild", "owner-b")).toEqual([
      { id: "root", ownerMemberId: null },
      { id: "child-a", ownerMemberId: "owner-b" },
      { id: "grandchild", ownerMemberId: "owner-b" },
    ]);
  });

  it("rolls every distinct descendant owner up to a parent", () => {
    const rollups = buildGanttOwnerRollups([
      { id: "root", parentId: null, ownerMemberId: null },
      { id: "one", parentId: "root", ownerMemberId: "owner-a" },
      { id: "two", parentId: "root", ownerMemberId: "owner-b" },
      { id: "three", parentId: "root", ownerMemberId: "owner-c" },
    ]);

    expect(rollups.get("root")).toEqual(["owner-a", "owner-b", "owner-c"]);
  });

  it("deduplicates multiple project roles for one account using a stable member id", () => {
    const identities = buildGanttOwnerIdentityIndex([
      { id: "member-z", accountId: "account-a", personName: "张三" },
      { id: "member-a", accountId: "account-a", personName: "张三" },
      { id: "member-b", accountId: "account-b", personName: "李四" },
    ]);
    const rollups = buildGanttOwnerRollups([
      { id: "root", parentId: null, ownerMemberId: null },
      { id: "one", parentId: "root", ownerMemberId: "member-z" },
      { id: "two", parentId: "root", ownerMemberId: "member-a" },
    ], identities);

    expect(rollups.get("root")).toEqual(["member-a"]);
    expect(planGanttOwnerHierarchyNormalization([
      { id: "root", parentId: null, ownerMemberId: null },
      { id: "one", parentId: "root", ownerMemberId: "member-z" },
      { id: "two", parentId: "root", ownerMemberId: "member-a" },
    ], identities)).toEqual([{ id: "root", ownerMemberId: "member-a" }]);
  });

  it("normalizes mixed parents while leaving leaf assignments unchanged", () => {
    expect(planGanttOwnerHierarchyNormalization([
      { id: "root", parentId: null, ownerMemberId: "owner-a" },
      { id: "one", parentId: "root", ownerMemberId: "owner-a" },
      { id: "two", parentId: "root", ownerMemberId: "owner-b" },
    ])).toEqual([{ id: "root", ownerMemberId: null }]);
  });

  it("returns the effective owner inherited by a newly inserted child", () => {
    expect(getEffectiveGanttOwnerMemberId(tasks, "child-a")).toBe("owner-a");
    expect(getEffectiveGanttOwnerMemberId([
      { id: "root", parentId: null, ownerMemberId: null },
      { id: "one", parentId: "root", ownerMemberId: "owner-a" },
      { id: "two", parentId: "root", ownerMemberId: "owner-b" },
    ], "root")).toBeNull();
  });

  it("maps every parent to its unassigned descendant leaf tasks", () => {
    const hierarchy = [
      { id: "root", parentId: null, ownerMemberId: "owner-a", taskName: "根任务" },
      { id: "branch", parentId: "root", ownerMemberId: "owner-a", taskName: "分支任务" },
      { id: "assigned", parentId: "branch", ownerMemberId: "owner-a", taskName: "已分配叶子" },
      { id: "unassigned", parentId: "branch", ownerMemberId: null, taskName: "未分配叶子" },
    ];

    const warnings = buildGanttUnassignedLeafTasksByParentId(hierarchy);

    expect(warnings.get("root")?.map((task) => task.id)).toEqual(["unassigned"]);
    expect(warnings.get("branch")?.map((task) => task.id)).toEqual(["unassigned"]);
    expect(warnings.has("assigned")).toBe(false);
    expect(warnings.has("unassigned")).toBe(false);
  });

  it("does not let a stored parent owner mask an unassigned leaf", () => {
    const warnings = buildGanttUnassignedLeafTasksByParentId([
      { id: "root", parentId: null, ownerMemberId: "owner-a" },
      { id: "leaf", parentId: "root", ownerMemberId: null },
    ]);

    expect(warnings.get("root")?.map((task) => task.id)).toEqual(["leaf"]);
  });

  it("backfills only unassigned descendants from their nearest assigned ancestor", () => {
    expect(planGanttLegacyOwnerBackfill([
      { id: "root", parentId: null, ownerMemberId: "owner-a" },
      { id: "branch", parentId: "root", ownerMemberId: "owner-b" },
      { id: "leaf-nearest", parentId: "branch", ownerMemberId: null },
      { id: "leaf-existing", parentId: "branch", ownerMemberId: "owner-c" },
      { id: "root-leaf", parentId: "root", ownerMemberId: null },
    ])).toEqual([
      { id: "leaf-nearest", ownerMemberId: "owner-b" },
      { id: "root-leaf", ownerMemberId: "owner-a" },
    ]);
  });
});
