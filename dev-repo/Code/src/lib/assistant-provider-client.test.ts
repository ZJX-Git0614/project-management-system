import { describe, expect, it, vi } from "vitest";

import { consumeAssistantProviderStream } from "@/lib/assistant-provider-client";

describe("assistant provider streaming", () => {
  it("streams public answer text and ignores private reasoning fields", async () => {
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"hidden reasoning"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"项目"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"正常"}}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const onDelta = vi.fn();

    const result = await consumeAssistantProviderStream(response, onDelta);

    expect(result).toBe("项目正常");
    expect(onDelta.mock.calls.flat()).toEqual(["项目", "正常"]);
    expect(onDelta.mock.calls.flat().join("")).not.toContain("hidden reasoning");
  });
});
