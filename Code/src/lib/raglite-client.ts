import type { AssistantRuntimeConfig } from "@/lib/assistant-settings";

export type RagLiteQueryResult = {
  answer?: string;
  chunks?: Array<{ content: string; metadata?: Record<string, unknown> }>;
};

export const queryRagLite = async (
  input: { query: string; projectId?: string; categories: string[] },
  runtime: AssistantRuntimeConfig,
  signal?: AbortSignal,
): Promise<RagLiteQueryResult | null> => {
  if (!runtime.retrievalEnabled || !runtime.ragliteBaseUrl || !runtime.embeddingProvider) return null;
  try {
    const response = await fetch(`${runtime.ragliteBaseUrl}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(runtime.ragliteToken ? { Authorization: `Bearer ${runtime.ragliteToken}` } : {}),
      },
      signal,
      body: JSON.stringify({
        ...input,
        limit: runtime.retrievalTopK,
        runtimeConfig: {
          embeddingProvider: {
            providerType: runtime.embeddingProvider.providerType,
            baseUrl: runtime.embeddingProvider.baseUrl,
            model: runtime.embeddingProvider.model,
            apiKey: runtime.embeddingProvider.apiKey,
          },
          chunkMaxSize: runtime.chunkMaxSize,
          vectorDistanceMetric: runtime.vectorDistanceMetric,
          vectorSearchMultivector: runtime.vectorSearchMultivector,
          vectorSearchQueryAdapter: runtime.vectorSearchQueryAdapter,
          rerankerEnabled: runtime.rerankerEnabled,
        },
      }),
    });
    return response.ok ? await response.json() as RagLiteQueryResult : null;
  } catch {
    return null;
  }
};

export const testRagLiteConnection = async (runtime: AssistantRuntimeConfig) => {
  if (!runtime.ragliteBaseUrl) return { ok: false, message: "请先填写 RAGLite 服务地址" };
  try {
    const response = await fetch(`${runtime.ragliteBaseUrl}/health`, {
      headers: runtime.ragliteToken ? { Authorization: `Bearer ${runtime.ragliteToken}` } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok
      ? { ok: true, message: "RAGLite 服务连接正常" }
      : { ok: false, message: `RAGLite 服务响应异常（HTTP ${response.status}）` };
  } catch {
    return { ok: false, message: "无法连接 RAGLite 服务" };
  }
};
