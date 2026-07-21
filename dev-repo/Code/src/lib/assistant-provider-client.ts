import type { AssistantRuntimeProvider } from "@/lib/assistant-settings";

const normalizedBaseUrl = (provider: AssistantRuntimeProvider) => {
  const base = provider.baseUrl.replace(/\/$/, "");
  return provider.providerType === "OLLAMA" && !base.endsWith("/v1") ? `${base}/v1` : base;
};

const headers = (provider: AssistantRuntimeProvider) => ({
  "Content-Type": "application/json",
  ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
});

const withTimeout = async <T>(timeoutMs: number, callback: (signal: AbortSignal) => Promise<T>) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await callback(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

export const listAssistantProviderModels = async (provider: AssistantRuntimeProvider) => {
  try {
    return await withTimeout(12_000, async (signal) => {
      const response = await fetch(`${normalizedBaseUrl(provider)}/models`, {
        headers: headers(provider),
        signal,
      });
      if (!response.ok) return { ok: false, message: `获取模型列表失败（HTTP ${response.status}）`, models: [] as string[] };
      const payload = await response.json().catch(() => ({})) as {
        data?: Array<{ id?: string; name?: string }>;
        models?: Array<{ name?: string; model?: string }>;
      };
      const models = [
        ...(payload.data ?? []).map((item) => item.id || item.name || ""),
        ...(payload.models ?? []).map((item) => item.name || item.model || ""),
      ].map((item) => item.trim()).filter(Boolean);
      return { ok: true, message: "模型列表获取成功", models: Array.from(new Set(models)).sort() };
    });
  } catch {
    return { ok: false, message: "无法获取模型列表，请检查地址、密钥和网络", models: [] as string[] };
  }
};

export const testAssistantProviderConnection = async (provider: AssistantRuntimeProvider) => {
  try {
    return await withTimeout(15_000, async (signal) => {
      const llm = provider.providerKind === "LLM";
      const response = await fetch(`${normalizedBaseUrl(provider)}${llm ? "/chat/completions" : "/embeddings"}`, {
        method: "POST",
        headers: headers(provider),
        signal,
        body: JSON.stringify(llm
          ? { model: provider.model, temperature: 0, max_tokens: 8, messages: [{ role: "user", content: "只回复 OK" }] }
          : { model: provider.model, input: ["PMS connection test"] }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        return { ok: false, message: `连接失败（HTTP ${response.status}）${detail ? `：${detail.slice(0, 160)}` : ""}` };
      }
      return { ok: true, message: `${provider.name} 连接正常` };
    });
  } catch {
    return { ok: false, message: "连接超时或无法访问，请检查接口地址和网络" };
  }
};

const extractModelText = (payload: unknown) => {
  if (!payload || typeof payload !== "object") return "";
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((item) => item && typeof item === "object" && "text" in item ? String(item.text || "") : "").join("\n").trim();
};

export const callAssistantProviderModel = async (params: {
  provider: AssistantRuntimeProvider;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
}) => {
  const response = await fetch(`${normalizedBaseUrl(params.provider)}/chat/completions`, {
    method: "POST",
    headers: headers(params.provider),
    signal: params.signal,
    body: JSON.stringify({
      model: params.provider.model,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      messages: params.messages,
    }),
  });
  if (!response.ok) throw new Error(`模型调用失败（HTTP ${response.status}）`);
  return extractModelText(await response.json());
};
