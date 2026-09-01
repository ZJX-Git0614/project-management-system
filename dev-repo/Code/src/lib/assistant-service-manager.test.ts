import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getAssistantServiceManagerStatus,
  runAssistantHostServiceAction,
} from "@/lib/assistant-service-manager";

describe("assistant host service manager client", () => {
  const previousUrl = process.env.ASSISTANT_SERVICE_MANAGER_URL;
  const previousToken = process.env.ASSISTANT_SERVICE_MANAGER_TOKEN;

  afterEach(() => {
    process.env.ASSISTANT_SERVICE_MANAGER_URL = previousUrl;
    process.env.ASSISTANT_SERVICE_MANAGER_TOKEN = previousToken;
    vi.unstubAllGlobals();
  });

  it("returns an explicit unavailable state when the deployment bridge is not configured", async () => {
    delete process.env.ASSISTANT_SERVICE_MANAGER_URL;
    delete process.env.ASSISTANT_SERVICE_MANAGER_TOKEN;
    const status = await getAssistantServiceManagerStatus();
    expect(status.available).toBe(false);
    expect(status.services.map((service) => service.name)).toEqual(["Ollama", "RagLite"]);
  });

  it("keeps the bridge token on the server request", async () => {
    process.env.ASSISTANT_SERVICE_MANAGER_URL = "http://host.docker.internal:8766/";
    process.env.ASSISTANT_SERVICE_MANAGER_TOKEN = "secret-token";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: "Ollama 已启动",
      status: { available: true, message: "正常", services: [] },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await runAssistantHostServiceAction({ service: "Ollama", action: "Start" });

    expect(fetchMock).toHaveBeenCalledWith("http://host.docker.internal:8766/action", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
    }));
  });
});
