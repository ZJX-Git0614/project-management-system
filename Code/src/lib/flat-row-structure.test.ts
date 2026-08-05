import { describe, expect, it } from "vitest";

import { normalizeStructureCount, placeRowsAroundAnchor } from "@/lib/flat-row-structure";

const rows = ["a", "b", "c", "d"].map((id) => ({ id }));

describe("placeRowsAroundAnchor", () => {
  it("moves rows while preserving their supplied order", () => {
    expect(placeRowsAroundAnchor(rows, [rows[1], rows[2]], "d", "AFTER").map((row) => row.id))
      .toEqual(["a", "d", "b", "c"]);
  });

  it("inserts copied rows before the target", () => {
    expect(placeRowsAroundAnchor(rows, [{ id: "x" }, { id: "y" }], "b", "BEFORE").map((row) => row.id))
      .toEqual(["a", "x", "y", "b", "c", "d"]);
  });

  it("rejects a move onto the selected row", () => {
    expect(() => placeRowsAroundAnchor(rows, [rows[1]], "b", "AFTER"))
      .toThrow("不能粘贴到被剪切的行自身");
  });
});

describe("normalizeStructureCount", () => {
  it("clamps invalid and excessive values", () => {
    expect(normalizeStructureCount("bad")).toBe(1);
    expect(normalizeStructureCount(0)).toBe(1);
    expect(normalizeStructureCount(999)).toBe(100);
  });
});
