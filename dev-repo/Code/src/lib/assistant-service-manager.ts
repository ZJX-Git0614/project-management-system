export type AssistantHostServiceName = "Ollama" | "RagLite";
export type AssistantHostServiceAction = "Start" | "Stop" | "Restart" | "EnableAutoStart" | "DisableAutoStart";

export type AssistantHostServiceState = {
  name: AssistantHostServiceName;
  label: string;
  healthy: boolean;
  autoStartEnabled: boolean;
  configured: boolean;
  healthUrl: string;
  message: string;
};

export type AssistantServiceManagerStatus = {
  available: boolean;
  message: string;
  services: AssistantHostServiceState[];
  ragLiteConfiguration?: {
    directory: string;
    executable: string;
    arguments: string;
  };
};

const managerUrl = () => (process.env.ASSISTANT_SERVICE_MANAGER_URL || "").trim().replace(/\/$/, "");
const managerToken = () => (process.env.ASSISTANT_SERVICE_MANAGER_TOKEN || "").trim();

const unavailableStatus = (message = "当前部署未配置主机服务管理桥接") => ({
  available: false,
  message,
  services: [
    { name: "Ollama" as const, label: "Ollama", healthy: false, autoStartEnabled: false, configured: false, healthUrl: "", message },
    { name: "RagLite" as const, label: "RAGLite", healthy: false, autoStartEnabled: false, configured: false, healthUrl: "", message },
  ],
});

const requestManager = async <T>(path: string, init?: RequestInit, timeoutMs = 8_000): Promise<T> => {
  const baseUrl = managerUrl();
  const token = managerToken();
  if (!baseUrl || !token) throw new Error("当前部署未配置主机服务管理桥接");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    const body = await response.json().catch(() => ({})) as { error?: string } & T;
    if (!response.ok) throw new Error(body.error || `主机服务管理响应异常（HTTP ${response.status}）`);
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("主机服务管理响应超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const getAssistantServiceManagerStatus = async (): Promise<AssistantServiceManagerStatus> => {
  if (!managerUrl() || !managerToken()) return unavailableStatus();
  try {
    return await requestManager<AssistantServiceManagerStatus>("/status");
  } catch (error) {
    return unavailableStatus(error instanceof Error ? error.message : "无法连接主机服务管理桥接");
  }
};

export const runAssistantHostServiceAction = async (params: {
  service: AssistantHostServiceName;
  action: AssistantHostServiceAction;
}) => requestManager<{ message: string; status: AssistantServiceManagerStatus }>("/action", {
  method: "POST",
  body: JSON.stringify(params),
}, 45_000);

export const configureRagLiteHostService = async (params: {
  directory: string;
  executable: string;
  arguments: string;
}) => requestManager<{ message: string; status: AssistantServiceManagerStatus }>("/configure-raglite", {
  method: "POST",
  body: JSON.stringify(params),
}, 15_000);
