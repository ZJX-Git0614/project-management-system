import { afterEach, describe, expect, it, vi } from "vitest";

import { listAssistantProviderModels } from "@/lib/assistant-provider-client";
import type { AssistantRuntimeProvider } from "@/lib/assistant-settings";

const provider = (overrides: Partial<AssistantRuntimeProvider> = {}): AssistantRuntimeProvider => ({
  id: "provider-1",
  providerKind: "LLM",
  providerType: "OPENAI_COMPATIBLE",
  name: "测试供应商",
  baseUrl: "https://models.example.com/v1/",
  model: "model-a",
  apiKey: "secret",
  ...overrides,
});

describe("assistant provider model discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges OpenAI and Ollama model payloads, then removes duplicates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "model-b" }, { id: "model-a" }],
      models: [{ name: "model-b" }, { model: "embed-c" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listAssistantProviderModels(provider());

    expect(result).toEqual({ ok: true, message: "模型列表获取成功", models: ["embed-c", "model-a", "model-b"] });
    expect(fetchMock).toHaveBeenCalledWith("https://models.example.com/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer secret" }),
    }));
  });

  it("normalizes an Ollama endpoint to its OpenAI-compatible v1 model route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ name: "nomic-embed-text" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listAssistantProviderModels(provider({
      providerKind: "EMBEDDING",
      providerType: "OLLAMA",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: "",
    }));

    expect(result.models).toEqual(["nomic-embed-text"]);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:11434/v1/models", expect.any(Object));
  });
});
