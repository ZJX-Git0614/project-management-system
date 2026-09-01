import type { AssistantActionRun } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { verifyAssistantActionResult } from "@/lib/assistant-action-execution";

const action = (processedCount: number) => ({
  toolId: "risk.create.batch",
  argsJson: JSON.stringify({ risks: [{ riskName: "进度延期风险" }, { riskName: "成本超支风险" }] }),
  resultJson: JSON.stringify({
    message: "批量登记完成",
    requestedCount: 2,
    processedCount,
    riskIds: processedCount === 2 ? ["risk-1", "risk-2"] : ["risk-1"],
    riskCodes: processedCount === 2 ? ["Risk001", "Risk002"] : ["Risk001"],
  }),
} as AssistantActionRun);

describe("assistant action execution verification", () => {
  it("accepts a complete batch risk result", () => {
    expect(verifyAssistantActionResult(action(2))).toMatchObject({ passed: true });
  });

  it("rejects a partially processed risk batch", () => {
    expect(() => verifyAssistantActionResult(action(1))).toThrow("要求登记 2 条风险");
  });
});
