import { describe, expect, it } from "vitest";

import {
  emptyGanttHistoryState,
  pushGanttHistoryEntry,
  type GanttHistoryEntry,
} from "@/lib/gantt-history";

const entry = (index: number): GanttHistoryEntry => ({
  id: `entry-${index}`,
  kind: "SNAPSHOT",
  label: `操作 ${index}`,
  beforeSnapshotId: `before-${index}`,
  afterSnapshotId: `after-${index}`,
  target: { taskIds: [`task-${index}`] },
});

describe("gantt history", () => {
  it("keeps only the latest fifty committed operations", () => {
    let state = emptyGanttHistoryState();
    for (let index = 1; index <= 55; index += 1) state = pushGanttHistoryEntry(state, entry(index));

    expect(state.entries).toHaveLength(50);
    expect(state.entries[0].id).toBe("entry-6");
    expect(state.entries.at(-1)?.id).toBe("entry-55");
    expect(state.cursor).toBe(49);
  });

  it("drops the redo branch when a new operation is committed after undo", () => {
    let state = emptyGanttHistoryState();
    state = pushGanttHistoryEntry(state, entry(1));
    state = pushGanttHistoryEntry(state, entry(2));
    state = pushGanttHistoryEntry(state, entry(3));
    state = { ...state, cursor: 0 };

    state = pushGanttHistoryEntry(state, entry(4));

    expect(state.entries.map((item) => item.id)).toEqual(["entry-1", "entry-4"]);
    expect(state.cursor).toBe(1);
  });
});
