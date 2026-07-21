import { afterEach, describe, expect, it } from "vitest";

import {
  buildAssistantPersonaInstruction,
  buildAssistantWelcomeMessage,
  normalizeAssistantPersonaPreset,
} from "@/lib/assistant-persona";
import { decryptAssistantSecret, encryptAssistantSecret } from "@/lib/assistant-secrets";

describe("assistant settings foundations", () => {
  const originalSecret = process.env.ASSISTANT_CONFIG_ENCRYPTION_KEY;

  afterEach(() => {
    process.env.ASSISTANT_CONFIG_ENCRYPTION_KEY = originalSecret;
  });

  it("encrypts provider secrets without storing plaintext", () => {
    process.env.ASSISTANT_CONFIG_ENCRYPTION_KEY = "assistant-test-key";
    const encrypted = encryptAssistantSecret("sk-private-value");

    expect(encrypted).not.toContain("sk-private-value");
    expect(decryptAssistantSecret(encrypted)).toBe("sk-private-value");
  });

  it("normalizes unsupported personas and keeps project wording", () => {
    expect(normalizeAssistantPersonaPreset("UNKNOWN")).toBe("PROFESSIONAL");
    expect(buildAssistantWelcomeMessage("PROFESSIONAL", "项目助手", "示例项目"))
      .toContain("示例项目");
    expect(buildAssistantPersonaInstruction("COOL", "")).toContain("冷静");
  });
});
