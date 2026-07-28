import { describe, expect, it } from "vitest";

import {
  buildGanttDate,
  isValidGanttDate,
  normalizeEditedGanttYear,
  splitGanttDate,
} from "@/lib/gantt-date-input";

describe("gantt date input", () => {
  it("splits an ISO date into editable segments", () => {
    expect(splitGanttDate("2026-07-22")).toEqual({ year: "2026", month: "07", day: "22" });
  });

  it("uses the current century for a two-digit year", () => {
    expect(buildGanttDate(
      { year: "27", month: "7", day: "2" },
      { allowShortSegments: true, currentYear: 2026 },
    )).toBe("2027-07-02");
  });

  it("preserves a manually entered four-digit year", () => {
    expect(buildGanttDate(
      { year: "1999", month: "12", day: "31" },
      { allowShortSegments: true, currentYear: 2026 },
    )).toBe("1999-12-31");
  });

  it("uses the current century when only the last two year digits are replaced", () => {
    expect(normalizeEditedGanttYear("0002", "0003", 2026)).toBe("2003");
    expect(normalizeEditedGanttYear("1999", "1988", 2026)).toBe("2088");
    expect(normalizeEditedGanttYear("26", "1999", 2026)).toBe("1999");
  });

  it("rejects incomplete and invalid dates", () => {
    expect(buildGanttDate({ year: "2026", month: "0", day: "" }, { allowShortSegments: true })).toBeNull();
    expect(isValidGanttDate("2026-02-29")).toBe(false);
  });
});
