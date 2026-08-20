import { describe, expect, it } from "vitest";

import {
  buildResourceSerialLinks,
  calculateResourceAwareGanttCpm,
  type ResourceCpmTask,
} from "@/lib/gantt-resource-cpm";

const task = (
  id: string,
  startDate: string,
  finishDate: string,
  durationDays: number,
  options: Partial<ResourceCpmTask> = {},
): ResourceCpmTask => ({
  id,
  parentId: "root",
  startDate,
  finishDate,
  durationDays,
  ownerKeys: ["person:孟洵"],
  ...options,
});

describe("resource-aware gantt CPM", () => {
  it("serializes active tasks for the same person and includes the chain in CPM", () => {
    const tasks = [
      task("root", "2026-08-17", "2026-09-01", 12, { parentId: null, ownerKeys: [] }),
      task("1.4.3", "2026-08-17", "2026-08-26", 8),
      task("1.4.1", "2026-08-27", "2026-08-27", 1),
      task("1.4.2", "2026-08-28", "2026-08-28", 1),
      task("1.2.1", "2026-08-31", "2026-09-01", 2, {
        predecessorDependencies: [{ predecessorTaskId: "1.4.3", type: 1, lag: 0, lagFormat: 7 }],
      }),
    ];

    const result = calculateResourceAwareGanttCpm(tasks, "WORKING_DAYS");

    expect(result.resourceLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ predecessorTaskId: "1.4.1", successorTaskId: "1.4.2" }),
      expect.objectContaining({ predecessorTaskId: "1.2.1", successorTaskId: "1.4.1" }),
      expect.objectContaining({ predecessorTaskId: "1.4.3", successorTaskId: "1.2.1" }),
    ]));
    expect(result.metricsByTaskId.get("1.4.1")).toMatchObject({
      totalFloatMinutes: 0,
      isCritical: true,
    });
    expect(result.projectCriticalTaskIds).toEqual(new Set(["1.4.3", "1.2.1", "1.4.1", "1.4.2"]));
  });

  it("keeps the resource critical chain visible when a locked parent boundary is too short", () => {
    const tasks = [
      task("root", "2026-08-17", "2026-09-01", 12, { parentId: null, ownerKeys: [] }),
      task("parent", "2026-08-17", "2026-08-28", 10, {
        parentId: "root",
        ownerKeys: [],
        parentBoundaryMode: "LOCKED",
      }),
      task("1.4.3", "2026-08-17", "2026-08-26", 8, { parentId: "parent" }),
      task("1.4.1", "2026-08-27", "2026-08-27", 1, { parentId: "parent" }),
      task("1.4.2", "2026-08-28", "2026-08-28", 1, { parentId: "parent" }),
      task("1.2.1", "2026-08-31", "2026-09-01", 2, {
        predecessorDependencies: [{ predecessorTaskId: "1.4.3", type: 1, lag: 0, lagFormat: 7 }],
      }),
    ];

    const result = calculateResourceAwareGanttCpm(tasks, "WORKING_DAYS");

    expect(result.projectCriticalTaskIds).toEqual(new Set(["1.4.3", "1.2.1", "1.4.1", "1.4.2"]));
    expect(result.metricsByTaskId.get("1.4.1")).toMatchObject({
      isCritical: true,
      scheduleStatus: "NEGATIVE_FLOAT",
    });
    expect(result.metricsByTaskId.get("1.4.1")?.totalFloatMinutes).toBeLessThan(0);
  });

  it("does not create a derived cycle when an explicit dependency points backwards", () => {
    const tasks = [
      task("a", "2026-08-18", "2026-08-18", 1, {
        predecessorDependencies: [{ predecessorTaskId: "b", type: 1, lag: 0, lagFormat: 7 }],
      }),
      task("b", "2026-08-17", "2026-08-17", 1),
    ];

    const links = buildResourceSerialLinks(tasks);

    expect(links).not.toContainEqual(expect.objectContaining({
      predecessorTaskId: "a",
      successorTaskId: "b",
    }));
  });

  it("uses dependency ids from list payloads when dependency objects are absent", () => {
    const links = buildResourceSerialLinks([
      task("predecessor", "2026-08-17", "2026-08-17", 1),
      task("successor", "2026-08-18", "2026-08-18", 1, {
        predecessorDependencies: [],
        predecessorTaskIds: ["predecessor"],
      }),
      task("unrelated", "2026-08-19", "2026-08-19", 1),
    ]);

    expect(links.map(({ predecessorTaskId, successorTaskId }) => `${predecessorTaskId}->${successorTaskId}`)).toEqual([
      "predecessor->successor",
      "successor->unrelated",
    ]);
  });

  it("uses owner members when a list payload omits direct owner ids", () => {
    const ownerMembers = [{ id: "member-1", accountId: "account-1", personName: "孟洵" }];
    const links = buildResourceSerialLinks([
      task("predecessor", "2026-08-17", "2026-08-17", 1, {
        ownerKeys: [],
        ownerMemberIds: [],
        ownerMembers,
      }),
      task("successor", "2026-08-18", "2026-08-18", 1, {
        ownerKeys: [],
        ownerMemberIds: [],
        ownerMembers,
      }),
    ]);

    expect(links).toEqual([
      expect.objectContaining({
        predecessorTaskId: "predecessor",
        successorTaskId: "successor",
        ownerKey: "member:member-1",
      }),
    ]);
  });
});
