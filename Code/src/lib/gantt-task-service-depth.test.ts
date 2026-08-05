import { describe, expect, it } from "vitest";

import {
  ganttSnapshotOwnerLinkRows,
  ganttSnapshotOwnerMemberIds,
  ganttTaskIdsAtOrBeyondDepth,
  serializeGanttTaskList,
} from "@/lib/gantt-task-service";

describe("ganttTaskIdsAtOrBeyondDepth", () => {
  it("selects only fifth-level and deeper descendants from the parent hierarchy", () => {
    const tasks = [
      { id: "one", parentId: null },
      { id: "two", parentId: "one" },
      { id: "three", parentId: "two" },
      { id: "four", parentId: "three" },
      { id: "five", parentId: "four" },
      { id: "six", parentId: "five" },
      { id: "other-root", parentId: null },
    ];

    expect(ganttTaskIdsAtOrBeyondDepth(tasks, 5)).toEqual(["five", "six"]);
  });

  it("keeps malformed parent references at root depth instead of deleting them", () => {
    expect(ganttTaskIdsAtOrBeyondDepth([
      { id: "orphan", parentId: "missing" },
      { id: "cycle-a", parentId: "cycle-b" },
      { id: "cycle-b", parentId: "cycle-a" },
    ], 2)).toEqual([]);
  });
});

describe("serializeGanttTaskList owner rollups", () => {
  const task = (
    id: string,
    parentId: string | null,
    ownerMember: { id: string; accountId: string | null; personName: string; roleName: string } | null,
  ) => ({
    id,
    parentId,
    ownerMemberId: ownerMember?.id ?? null,
    ownerMember,
    predecessorDependencies: [],
    createdAt: new Date("2026-08-04T00:00:00.000Z"),
    updatedAt: new Date("2026-08-04T00:00:00.000Z"),
    scheduleCalculatedAt: null,
  });

  it("uses one canonical owner when child assignments reference two roles of the same account", () => {
    const rows = serializeGanttTaskList([
      task("root", null, null),
      task("child-a", "root", { id: "member-z", accountId: "account-1", personName: "张三", roleName: "开发" }),
      task("child-b", "root", { id: "member-a", accountId: "account-1", personName: "张三", roleName: "测试" }),
    ] as never);

    expect(rows[0].ownerMembers).toEqual([expect.objectContaining({
      id: "member-a",
      personName: "张三",
      roleNames: ["开发", "测试"],
    })]);
    expect(rows[0].ownerReadOnly).toBe(true);
  });
});

describe("gantt owner snapshots", () => {
  it("uses multi-owner links and keeps legacy snapshots backward compatible", () => {
    expect(ganttSnapshotOwnerMemberIds({
      ownerMemberId: null,
      ownerLinks: [
        { projectMemberId: "member-a" },
        { projectMemberId: "member-b" },
        { projectMemberId: "member-a" },
      ],
    })).toEqual(["member-a", "member-b"]);
    expect(ganttSnapshotOwnerMemberIds({ ownerMemberId: "legacy-member" })).toEqual(["legacy-member"]);
  });

  it("filters missing project members while rebuilding owner links", () => {
    expect(ganttSnapshotOwnerLinkRows([
      { id: "task-1", ownerLinks: [{ projectMemberId: "member-a" }, { projectMemberId: "missing" }] },
      { id: "task-2", ownerMemberId: "member-b" },
    ], new Set(["member-a", "member-b"]))).toEqual([
      { taskId: "task-1", projectMemberId: "member-a" },
      { taskId: "task-2", projectMemberId: "member-b" },
    ]);
  });
});
