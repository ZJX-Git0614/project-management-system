import { describe, expect, it } from "vitest";

import { nextRiskCode, renumberRiskCodes } from "@/lib/risk-register-codes";

describe("risk register codes", () => {
  it("generates the next padded risk code", () => {
    expect(nextRiskCode([
      { id: "a", riskCode: "Risk001", sortOrder: 1, createdAt: "2026-01-01" },
      { id: "b", riskCode: "Risk009", sortOrder: 2, createdAt: "2026-01-02" },
    ])).toBe("Risk010");
  });

  it("renumbers risk codes from the persisted display order", () => {
    const result = renumberRiskCodes([
      { id: "later", riskCode: "Risk001", sortOrder: 2, createdAt: "2026-01-02" },
      { id: "first", riskCode: "Risk002", sortOrder: 1, createdAt: "2026-01-01" },
    ]);

    expect(result.find((item) => item.id === "first")?.riskCode).toBe("Risk001");
    expect(result.find((item) => item.id === "later")?.riskCode).toBe("Risk002");
  });
});
