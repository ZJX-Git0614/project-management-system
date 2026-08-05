import { describe, expect, it } from "vitest";

import {
  emptyModuleHistoryState,
  parseModuleHistoryState,
  pushModuleHistoryEntry,
  type ModuleHistoryEntry,
} from "@/lib/module-history";

const entry = (index: number): ModuleHistoryEntry => ({
  id: `entry-${index}`,
  label: `operation-${index}`,
  beforeSnapshotId: `before-${index}`,
  afterSnapshotId: `after-${index}`,
  targetIds: [`target-${index}`],
});

describe("module history", () => {
  it("drops the redo branch after a new operation", () => {
    const state = {
      entries: [entry(1), entry(2), entry(3)],
      cursor: 0,
    };

    expect(pushModuleHistoryEntry(state, entry(4))).toEqual({
      entries: [entry(1), entry(4)],
      cursor: 1,
    });
  });

  it("keeps only the most recent fifty entries", () => {
    const state = Array.from({ length: 55 }, (_, index) => index + 1)
      .reduce((current, index) => pushModuleHistoryEntry(current, entry(index)), emptyModuleHistoryState());

    expect(state.entries).toHaveLength(50);
    expect(state.entries[0].id).toBe("entry-6");
    expect(state.cursor).toBe(49);
  });

  it("parses valid session state and rejects malformed entries", () => {
    expect(parseModuleHistoryState(JSON.stringify({
      entries: [entry(1), { id: "broken" }],
      cursor: 20,
    }))).toEqual({ entries: [entry(1)], cursor: 0 });
    expect(parseModuleHistoryState("not json")).toEqual(emptyModuleHistoryState());
  });
});
