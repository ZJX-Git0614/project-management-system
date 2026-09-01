import { NextRequest } from "next/server";

import { err, ok } from "@/lib/api-utils";
import {
  buildAssistantIntentContract,
  buildAssistantPreflightTraceEvents,
} from "@/lib/assistant-intent-contract";
import { observeAssistantProjectExportData } from "@/lib/assistant-export-observation";
import { loadAssistantRuntimeConfig } from "@/lib/assistant-settings";
import { buildProjectAssistantContext } from "@/lib/project-assistant";
import { requireUser } from "@/lib/server-auth";

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if ("status" in user) return user;
  const runtime = await loadAssistantRuntimeConfig();
  if (!runtime.enabled) return err("智能助手已由管理员停用", 503);

  const body = await req.json().catch(() => ({})) as {
    message?: string;
    projectId?: string | null;
  };
  const message = String(body.message || "").trim();
  if (!message) return err("请输入需要查询的内容");
  if (message.length > 2000) return err("单次提问不能超过 2000 个字");
  const projectId = String(body.projectId || "").trim();
  const contract = buildAssistantIntentContract({ message, projectId });

  if (projectId) {
    const context = await buildProjectAssistantContext({ user, projectId });
    if (!context.project) return err("当前项目不存在或无权访问", 404);
  }

  const observation = contract.exportIntent
    && contract.exportIntent.exportType !== "scheduleAnalysis"
    && projectId
    ? await observeAssistantProjectExportData(projectId, contract.exportIntent)
    : undefined;

  return ok({
    contract,
    observation,
    events: buildAssistantPreflightTraceEvents({ contract, observation }),
  });
}
