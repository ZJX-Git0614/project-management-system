import { describe, expect, it } from "vitest";

import {
  abstractDateFromGanttOffset,
  formatGanttRelativeOffset,
  ganttOffsetFromAbstractDate,
} from "@/lib/gantt-relative-time";
import {
  ganttOffsetFromMaterializedDate,
  materializeGanttOffsetDate,
} from "@/lib/gantt-calendar";

describe("gantt relative T0 time", () => {
  it("formats an abstract workday without binding it to a calendar year", () => {
    expect(formatGanttRelativeOffset(0)).toBe("T0");
    expect(formatGanttRelativeOffset(10)).toBe("T0+10");
    expect(formatGanttRelativeOffset(2.5)).toBe("T0+2.5");
  });

  it("round-trips abstract offsets without consulting weekends or holidays", () => {
    expect(abstractDateFromGanttOffset(10)).toBe("2000-01-13");
    expect(ganttOffsetFromAbstractDate("2000-01-13")).toBe(10);
  });

  it("applies the real project calendar only when concrete T0 is provided", () => {
    expect(materializeGanttOffsetDate("2026-10-01", 0, "WORKING_DAYS")).toBe("2026-10-08");
    expect(materializeGanttOffsetDate("2026-10-01", 1, "WORKING_DAYS")).toBe("2026-10-09");
    expect(ganttOffsetFromMaterializedDate("2026-10-01", "2026-10-09", "WORKING_DAYS")).toBe(1);
  });
});
