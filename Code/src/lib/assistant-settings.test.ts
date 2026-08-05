import { afterEach, describe, expect, it } from "vitest";

import {
  buildAssistantPersonaInstruction,
  buildAssistantWelcomeMessage,
  normalizeAssistantPersonaPreset,
} from "@/lib/assistant-persona";
import { decryptAssistantSecret, encryptAssistantSecret } from "@/lib/assistant-secrets";
import {
  ASSISTANT_TOOL_CATALOG,
  DEFAULT_ASSISTANT_SYSTEM_PROMPT,
  defaultAssistantSettingsData,
  validateAssistantToolArgs,
} from "@/lib/assistant-settings";

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

  it("uses 佳佳 as the assistant identity", () => {
    expect(defaultAssistantSettingsData().assistantName).toBe("佳佳");
    expect(DEFAULT_ASSISTANT_SYSTEM_PROMPT).toContain("智能助手佳佳");
  });

  it("exposes the operational agent tools in the administrator settings", () => {
    const toolIds = ASSISTANT_TOOL_CATALOG.map((tool) => tool.id);
    expect(toolIds).toEqual(expect.arrayContaining([
      "todo.complete",
      "weekly.status.update",
      "risk.create",
      "risk.create.batch",
      "risk.status.update",
      "schedule.compare.file",
      "schedule.import.preview",
      "schedule.convert.file",
      "schedule.merge.files",
      "document.revision.generate",
      "gantt.resource.optimize",
    ]));
    expect(ASSISTANT_TOOL_CATALOG.find((tool) => tool.id === "schedule.convert.file")).toMatchObject({
      attachments: { min: 1, max: 1, extensions: [".mpp", ".xml", ".xls", ".xlsx"] },
      output: "FILE",
    });
    expect(ASSISTANT_TOOL_CATALOG.find((tool) => tool.id === "schedule.import.preview")?.attachments?.extensions)
      .toEqual(expect.arrayContaining([".mpp", ".xls", ".xlsx", ".csv", ".md", ".txt", ".docx", ".pdf"]));
  });

  it("publishes a complete executable contract for every tool", () => {
    for (const tool of ASSISTANT_TOOL_CATALOG) {
      expect(tool.version).toBeGreaterThan(0);
      expect(Array.isArray(tool.permissions)).toBe(true);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema.required.length).toBeGreaterThan(0);
      expect(tool.retryPolicy.maxAttempts).toBeGreaterThan(0);
      expect(tool.verifier).toBeTruthy();
    }
  });

  it("rejects undeclared or invalid tool arguments before execution", () => {
    expect(validateAssistantToolArgs("gantt.progress.update", { taskId: "task-1", progress: 35 })).toMatchObject({ ok: true });
    expect(validateAssistantToolArgs("gantt.progress.update", { taskId: "task-1", progress: 101 })).toMatchObject({ ok: false });
    expect(validateAssistantToolArgs("gantt.resource.optimize", { candidateKind: "MINIMAL_CHANGE", revision: 3, snapshotHash: "hash" })).toMatchObject({ ok: true });
    expect(validateAssistantToolArgs("gantt.resource.optimize", { candidateKind: "UNKNOWN", revision: 3, snapshotHash: "hash" })).toMatchObject({ ok: false });
    expect(validateAssistantToolArgs("weekly.status.update", { weeklyItemId: "item-1", progress: 100 })).toMatchObject({ ok: true });
    expect(validateAssistantToolArgs("weekly.status.update", { weeklyItemId: "item-1", status: "DONE", progress: 100 })).toMatchObject({ ok: false });
    expect(validateAssistantToolArgs("todo.create", { title: "核对计划", targetPersonName: "张三", injected: true })).toMatchObject({ ok: false });
    expect(validateAssistantToolArgs("schedule.merge.files", { attachmentIds: ["only-one"] })).toMatchObject({ ok: false });
    expect(validateAssistantToolArgs("project.export", { exportType: "gantt", taskDepths: [1, 2, 3] })).toMatchObject({ ok: true });
    expect(validateAssistantToolArgs("project.export", { exportType: "gantt", taskCategoryKeywords: ["前端"], includeProgressReport: true })).toMatchObject({ ok: true });
    expect(validateAssistantToolArgs("project.export", { exportType: "budget", includeVisualization: true })).toMatchObject({ ok: true });
    expect(validateAssistantToolArgs("project.export", { exportType: "gantt", includeProgressReport: "true" })).toMatchObject({ ok: false });
    expect(validateAssistantToolArgs("project.export", { exportType: "gantt", taskDepths: [0, 2] })).toMatchObject({ ok: false });
    expect(validateAssistantToolArgs("project.export", { exportType: "gantt", taskDepths: [1.5] })).toMatchObject({ ok: false });
    expect(validateAssistantToolArgs("risk.create.batch", { risks: [{ riskName: "供应商延期风险" }] })).toMatchObject({ ok: true });
    expect(validateAssistantToolArgs("risk.create.batch", { risks: [] })).toMatchObject({ ok: false });
  });
});
