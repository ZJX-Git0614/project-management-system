import { describe, expect, it } from "vitest";

import { upsertAssistantTraceEvent } from "@/lib/assistant-chat-stream";

describe("assistant chat stream", () => {
  it("updates an existing phase event without duplicating it", () => {
    const running = {
      id: "plan",
      phase: "PLAN" as const,
      title: "制定执行计划",
      summary: "正在规划",
      status: "RUNNING" as const,
    };
    const succeeded = { ...running, summary: "规划完成", status: "SUCCEEDED" as const };

    expect(upsertAssistantTraceEvent([running], succeeded)).toEqual([succeeded]);
  });
});
