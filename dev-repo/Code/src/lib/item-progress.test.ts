import { describe, expect, it } from "vitest";

import { ItemStatus } from "@/domain/enums";
import {
  isValidItemProgress,
  itemProgressFields,
  itemProgressInputValue,
  itemStatusFromProgress,
  localDateValue,
} from "@/lib/item-progress";

describe("item progress", () => {
  it.each([
    [0, ItemStatus.PENDING],
    [1, ItemStatus.IN_PROGRESS],
    [99, ItemStatus.IN_PROGRESS],
    [100, ItemStatus.DONE],
  ])("derives status from %i%% progress", (progress, status) => {
    expect(itemStatusFromProgress(progress)).toBe(status);
  });

  it("defaults the actual end date only when an item reaches 100%", () => {
    expect(itemProgressFields(100, "", "2026-07-31")).toEqual({
      progress: 100,
      status: ItemStatus.DONE,
      actualEndDate: "2026-07-31",
    });
    expect(itemProgressFields(100, "2026-07-30", "2026-07-31").actualEndDate).toBe("2026-07-30");
    expect(itemProgressFields(99, "", "2026-07-31").actualEndDate).toBe("");
    expect(itemProgressFields(100, "", "2026-07-31", 100).actualEndDate).toBe("");
  });

  it("formats dates without applying a UTC timezone shift", () => {
    expect(localDateValue(new Date(2026, 6, 31, 0, 30))).toBe("2026-07-31");
  });

  it("accepts only integer progress values from 0 through 100", () => {
    expect(isValidItemProgress(0)).toBe(true);
    expect(isValidItemProgress(100)).toBe(true);
    expect(isValidItemProgress(-1)).toBe(false);
    expect(isValidItemProgress(101)).toBe(false);
    expect(isValidItemProgress(10.5)).toBe(false);
    expect(isValidItemProgress("50")).toBe(false);
  });

  it("shows an empty inline editor for zero progress", () => {
    expect(itemProgressInputValue(0)).toBe("");
    expect(itemProgressInputValue(35)).toBe(35);
  });
});
