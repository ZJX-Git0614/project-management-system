import { describe, expect, it } from "vitest";

import { formatActionType, formatEntityType } from "@/lib/operation-history";

describe("delivery and procurement operation history labels", () => {
  it("keeps the new module entities readable in the shared audit view", () => {
    expect(formatEntityType("DELIVERY_ITEM")).toBe("交付物");
    expect(formatEntityType("DELIVERY_STATUS")).toBe("交付物状态");
    expect(formatEntityType("DELIVERY_BOM")).toBe("交付物 BOM/线缆清单");
    expect(formatEntityType("PROCUREMENT_ITEM")).toBe("采购条目");
    expect(formatEntityType("PROCUREMENT_STATUS")).toBe("采购状态");
    expect(formatEntityType("PROCUREMENT_BOM_SYNC")).toBe("采购 BOM 同步");
  });

  it("labels publish, sync and restore without hiding unknown actions", () => {
    expect(formatActionType("PUBLISH")).toBe("发布");
    expect(formatActionType("SYNC")).toBe("同步");
    expect(formatActionType("RESTORE")).toBe("恢复");
    expect(formatActionType("CUSTOM_ACTION")).toBe("CUSTOM_ACTION");
  });
});
