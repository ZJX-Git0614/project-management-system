import { NextRequest } from "next/server";

import { err, ok } from "@/lib/api-utils";
import {
  configureRagLiteHostService,
  getAssistantServiceManagerStatus,
  runAssistantHostServiceAction,
  type AssistantHostServiceAction,
  type AssistantHostServiceName,
} from "@/lib/assistant-service-manager";
import { requireSystemAdmin } from "@/lib/server-auth";

const serviceNames = new Set<AssistantHostServiceName>(["Ollama", "RagLite"]);
const serviceActions = new Set<AssistantHostServiceAction>([
  "Start",
  "Stop",
  "Restart",
  "EnableAutoStart",
  "DisableAutoStart",
]);

export async function GET(req: NextRequest) {
  const user = await requireSystemAdmin(req);
  if ("status" in user) return user;
  return ok(await getAssistantServiceManagerStatus());
}

export async function POST(req: NextRequest) {
  const user = await requireSystemAdmin(req);
  if ("status" in user) return user;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (body.operation === "ConfigureRagLite") {
    const directory = String(body.directory ?? "").trim();
    const executable = String(body.executable ?? "").trim();
    const argumentsValue = String(body.arguments ?? "").trim();
    if (!directory && !executable) return err("请填写 RAGLite 安装目录或启动程序路径");
    try {
      return ok(await configureRagLiteHostService({ directory, executable, arguments: argumentsValue }));
    } catch (error) {
      return err(error instanceof Error ? error.message : "RAGLite 配置失败", 502);
    }
  }

  const service = String(body.service ?? "") as AssistantHostServiceName;
  const action = String(body.action ?? "") as AssistantHostServiceAction;
  if (!serviceNames.has(service)) return err("主机服务名称无效");
  if (!serviceActions.has(action)) return err("主机服务操作无效");
  try {
    return ok(await runAssistantHostServiceAction({ service, action }));
  } catch (error) {
    return err(error instanceof Error ? error.message : "主机服务操作失败", 502);
  }
}
