import { describe, expect, it } from "vitest";

import { ganttTaskIdsAtOrBeyondDepth } from "@/lib/gantt-task-service";

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
