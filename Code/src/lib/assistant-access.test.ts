import { describe, expect, it } from "vitest";

import { normalizeAssistantAccessMode, shouldAutoExecuteAssistantAction } from "@/lib/assistant-access";

describe("assistant access mode", () => {
  it("falls back to request approval for unknown values", () => {
    expect(normalizeAssistantAccessMode("UNKNOWN")).toBe("REQUEST_APPROVAL");
  });

  it("auto approves routine operations without approving high-risk operations", () => {
    expect(shouldAutoExecuteAssistantAction("AUTO_APPROVE", "LOW")).toBe(true);
    expect(shouldAutoExecuteAssistantAction("AUTO_APPROVE", "MEDIUM")).toBe(true);
    expect(shouldAutoExecuteAssistantAction("AUTO_APPROVE", "HIGH")).toBe(false);
  });

  it("allows every supported action only in full access mode", () => {
    expect(shouldAutoExecuteAssistantAction("FULL_ACCESS", "HIGH")).toBe(true);
    expect(shouldAutoExecuteAssistantAction("REQUEST_APPROVAL", "LOW")).toBe(false);
  });
});
