import { describe, expect, it } from "vitest";

import {
  ganttSnapshotOwnerLinkRows,
  ganttSnapshotOwnerMemberIds,
  ganttTaskIdsAtOrBeyondDepth,
  rollupGanttParentRelativeSchedules,
  rollupGanttParentSchedules,
  rollupGanttParentActuals,
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

  it("keeps an unassigned parent owner readonly until its leaves are assigned", () => {
    const rows = serializeGanttTaskList([
      task("root", null, null),
      task("child", "root", null),
    ] as never);

    expect(rows[0].ownerReadOnly).toBe(true);
    expect(rows[1].ownerReadOnly).toBe(false);
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
      {
        taskId: "task-1",
        projectMemberId: "member-a",
        unitsPercent: 100,
        plannedWorkHours: 0,
        assignmentRole: "EXECUTOR",
      },
      {
        taskId: "task-2",
        projectMemberId: "member-b",
        unitsPercent: 100,
        plannedWorkHours: 0,
        assignmentRole: "EXECUTOR",
      },
    ]);
  });
});

describe("gantt parent actual rollups", () => {
  it("derives parent progress, work and dates from nested leaf actuals", () => {
    const rows = rollupGanttParentActuals([
      {
        id: "parent",
        parentId: null,
        actualStartDate: "stale",
        actualEndDate: "stale",
        actualStartSlot: "PM",
        actualFinishSlot: "AM",
        actualWorkHours: 999,
        progress: 100,
        estimatedWorkHours: 0,
        durationDays: 0,
      },
      {
        id: "child-a",
        parentId: "parent",
        actualStartDate: "2026-08-01",
        actualEndDate: "2026-08-02",
        actualStartSlot: "PM",
        actualFinishSlot: "AM",
        actualWorkHours: 7.5,
        progress: 100,
        estimatedWorkHours: 15,
        durationDays: 2,
      },
      {
        id: "child-b",
        parentId: "parent",
        actualStartDate: "2026-08-02",
        actualEndDate: "",
        actualStartSlot: "AM",
        actualFinishSlot: "PM",
        actualWorkHours: 3.75,
        progress: 50,
        estimatedWorkHours: 15,
        durationDays: 2,
      },
    ]);

    expect(rows.find((row) => row.id === "parent")).toMatchObject({
      actualStartDate: "2026-08-01",
      actualStartSlot: "PM",
      actualEndDate: "",
      actualFinishSlot: "PM",
      actualWorkHours: 11.25,
      progress: 75,
    });
  });

  it("only marks a parent complete when all children have completed actuals", () => {
    const rows = rollupGanttParentActuals([
      {
        id: "parent",
        parentId: null,
        actualStartDate: "",
        actualEndDate: "",
        actualWorkHours: 0,
        progress: 0,
        estimatedWorkHours: 0,
        durationDays: 0,
      },
      {
        id: "done-a",
        parentId: "parent",
        actualStartDate: "2026-08-01",
        actualEndDate: "2026-08-01",
        actualWorkHours: 7.5,
        progress: 100,
        estimatedWorkHours: 7.5,
        durationDays: 1,
      },
      {
        id: "done-b",
        parentId: "parent",
        actualStartDate: "2026-08-02",
        actualEndDate: "2026-08-03",
        actualFinishSlot: "PM",
        actualWorkHours: 7.5,
        progress: 100,
        estimatedWorkHours: 7.5,
        durationDays: 1,
      },
    ]);

    expect(rows.find((row) => row.id === "parent")).toMatchObject({
      actualStartDate: "2026-08-01",
      actualEndDate: "2026-08-03",
      actualFinishSlot: "PM",
      actualWorkHours: 15,
      progress: 100,
    });
  });
});

describe("gantt parent plan rollups", () => {
  it("普通派生刷新只汇总父级，绝不重排叶子计划字段", () => {
    const rows = rollupGanttParentSchedules([
      {
        id: "parent",
        parentId: null,
        parentBoundaryMode: "ROLLUP",
        startDate: "",
        finishDate: "",
        durationDays: 0,
        durationMinutes: 0,
        estimatedWorkHours: 0,
      },
      {
        id: "child-a",
        parentId: "parent",
        parentBoundaryMode: "ROLLUP",
        startDate: "2026-09-01",
        finishDate: "2026-09-02",
        durationDays: 2,
        durationMinutes: 900,
        estimatedWorkHours: 15,
      },
      {
        id: "child-b",
        parentId: "parent",
        parentBoundaryMode: "ROLLUP",
        startDate: "2026-09-05",
        finishDate: "2026-09-05",
        durationDays: 1,
        durationMinutes: 450,
        estimatedWorkHours: 7.5,
      },
    ], "CALENDAR_DAYS");

    expect(rows.find((row) => row.id === "parent")).toMatchObject({
      startDate: "2026-09-01",
      finishDate: "2026-09-05",
      durationDays: 5,
      estimatedWorkHours: 22.5,
    });
    expect(rows.find((row) => row.id === "child-a")).toMatchObject({
      startDate: "2026-09-01",
      finishDate: "2026-09-02",
      durationDays: 2,
      durationMinutes: 900,
      estimatedWorkHours: 15,
    });
    expect(rows.find((row) => row.id === "child-b")).toMatchObject({
      startDate: "2026-09-05",
      finishDate: "2026-09-05",
      durationDays: 1,
      durationMinutes: 450,
      estimatedWorkHours: 7.5,
    });
  });

  it("derives a T0 envelope for a locked parent without an explicit boundary", () => {
    const rows = rollupGanttParentRelativeSchedules([
      {
        id: "parent",
        parentId: null,
        parentBoundaryMode: "LOCKED",
        startDate: "2026-09-01",
        finishDate: "2026-09-10",
        relativeStartOffsetDays: null,
        relativeFinishOffsetDays: null,
        durationDays: 10,
        durationMinutes: 4500,
        estimatedWorkHours: 0,
      },
      {
        id: "child-a",
        parentId: "parent",
        parentBoundaryMode: "ROLLUP",
        startDate: "",
        finishDate: "",
        relativeStartOffsetDays: 2,
        relativeFinishOffsetDays: 4,
        durationDays: 3,
        durationMinutes: 1350,
        estimatedWorkHours: 22.5,
      },
      {
        id: "child-b",
        parentId: "parent",
        parentBoundaryMode: "ROLLUP",
        startDate: "",
        finishDate: "",
        relativeStartOffsetDays: 7,
        relativeFinishOffsetDays: 8,
        durationDays: 2,
        durationMinutes: 900,
        estimatedWorkHours: 15,
      },
    ]);

    expect(rows.find((row) => row.id === "parent")).toMatchObject({
      startDate: "2026-09-01",
      finishDate: "2026-09-10",
      relativeStartOffsetDays: 2,
      relativeFinishOffsetDays: 11,
      durationDays: 10,
      estimatedWorkHours: 37.5,
    });
  });

  it("refreshes an automatic parent T0 envelope when a child extends beyond stale parent offsets", () => {
    const rows = rollupGanttParentRelativeSchedules([
      {
        id: "parent",
        parentId: null,
        parentBoundaryMode: "ROLLUP",
        startDate: "",
        finishDate: "",
        relativeStartOffsetDays: 0,
        relativeFinishOffsetDays: 9,
        durationDays: 10,
        durationMinutes: 4500,
        estimatedWorkHours: 0,
      },
      {
        id: "child-a",
        parentId: "parent",
        parentBoundaryMode: "ROLLUP",
        startDate: "",
        finishDate: "",
        relativeStartOffsetDays: 0,
        relativeFinishOffsetDays: 2,
        durationDays: 3,
        durationMinutes: 1350,
        estimatedWorkHours: 22.5,
      },
      {
        id: "child-b",
        parentId: "parent",
        parentBoundaryMode: "ROLLUP",
        startDate: "",
        finishDate: "",
        relativeStartOffsetDays: 10,
        relativeFinishOffsetDays: 11,
        durationDays: 2,
        durationMinutes: 900,
        estimatedWorkHours: 15,
      },
    ]);

    expect(rows.find((row) => row.id === "parent")).toMatchObject({
      relativeStartOffsetDays: 0,
      relativeFinishOffsetDays: 11,
      durationDays: 12,
      estimatedWorkHours: 37.5,
    });
  });
});
