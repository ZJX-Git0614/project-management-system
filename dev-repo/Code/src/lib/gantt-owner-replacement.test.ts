import { describe, expect, it } from "vitest";

import { planGanttOwnerMemberReplacement } from "@/lib/gantt-owner-replacement";

describe("gantt owner member replacement", () => {
  it("replaces every directly owned task and keeps mixed parent ownership aggregated", () => {
    const updates = planGanttOwnerMemberReplacement([
      { id: "root", parentId: null, ownerMemberId: null },
      { id: "child-a", parentId: "root", ownerMemberId: "removed" },
      { id: "child-b", parentId: "root", ownerMemberId: "other" },
    ], "removed", "replacement");

    expect(updates).toEqual([
      { id: "child-a", ownerMemberId: "replacement" },
    ]);
  });

  it("rolls one replacement owner up when every child belonged to the removed member", () => {
    const updates = planGanttOwnerMemberReplacement([
      { id: "root", parentId: null, ownerMemberId: "removed" },
      { id: "child-a", parentId: "root", ownerMemberId: "removed" },
      { id: "child-b", parentId: "root", ownerMemberId: "removed" },
    ], "removed", "replacement");

    expect(updates).toEqual([
      { id: "root", ownerMemberId: "replacement" },
      { id: "child-a", ownerMemberId: "replacement" },
      { id: "child-b", ownerMemberId: "replacement" },
    ]);
  });

  it("supports explicitly leaving the removed member's work unassigned", () => {
    const updates = planGanttOwnerMemberReplacement([
      { id: "root", parentId: null, ownerMemberId: "removed" },
      { id: "child", parentId: "root", ownerMemberId: "removed" },
    ], "removed", null);

    expect(updates).toEqual([
      { id: "root", ownerMemberId: null },
      { id: "child", ownerMemberId: null },
    ]);
  });

  it("removes a deleted member from multi-owner links without disturbing the other owner", () => {
    const updates = planGanttOwnerMemberReplacement([
      { id: "root", parentId: null, ownerMemberId: null, ownerMemberIds: ["removed", "other"] },
      { id: "child", parentId: "root", ownerMemberId: null, ownerMemberIds: ["removed", "other"] },
    ], "removed", null);

    expect(updates).toEqual([
      { id: "root", ownerMemberId: "other", ownerMemberIds: ["other"] },
      { id: "child", ownerMemberId: "other", ownerMemberIds: ["other"] },
    ]);
  });
});
