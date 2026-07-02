import { describe, expect, it } from "vitest";

import {
  assignMissingWeeklyMatterCodes,
  nextWeeklyMatterCode,
  type WeeklyMatterCodeSource,
} from "@/lib/weekly-matter-codes";

const item = (overrides: Partial<WeeklyMatterCodeSource>): WeeklyMatterCodeSource => ({
  id: "weekly-1",
  matterCode: "",
  createdAt: "2026-07-01T00:00:00.000Z",
  ...overrides,
});

describe("weekly matter codes", () => {
  it("assigns Matter001-style codes to missing weekly items by creation order", () => {
    const items = assignMissingWeeklyMatterCodes([
      item({ id: "second", createdAt: "2026-07-02T00:00:00.000Z" }),
      item({ id: "first", createdAt: "2026-07-01T00:00:00.000Z" }),
    ]);

    expect(items.find((entry) => entry.id === "first")?.matterCode).toBe("Matter001");
    expect(items.find((entry) => entry.id === "second")?.matterCode).toBe("Matter002");
  });

  it("generates the next code after existing matter codes", () => {
    expect(nextWeeklyMatterCode([
      item({ id: "one", matterCode: "Matter001" }),
      item({ id: "two", matterCode: "Matter009" }),
    ])).toBe("Matter010");
  });
});
