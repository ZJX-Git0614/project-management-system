import { NextRequest } from "next/server";

import { err, ok } from "@/lib/api-utils";
import {
  serializeAssistantAction,
} from "@/lib/assistant-actions";
import { executeAssistantActionAndAdvancePlan, serializeAssistantPlan } from "@/lib/assistant-plans";
import {
  normalizeAssistantAccessMode,
  shouldAutoExecuteAssistantAction,
} from "@/lib/assistant-access";
import { buildAssistantCapabilityAnswer, searchAssistantManual } from "@/lib/assistant-manual";
import { loadAssistantRuntimeConfig } from "@/lib/assistant-settings";
import { prisma } from "@/lib/prisma";
import {
  buildProjectAssistantContext,
  type AssistantMessageInput,
} from "@/lib/project-assistant";
import {
  callProjectAssistantModel,
  planProjectAssistantQueryWithModel,
} from "@/lib/project-assistant-model";
import { resolveProjectAssistantAction } from "@/lib/project-assistant-agent";
import {
  buildProjectAssistantAnswerTrace,
  buildProjectAssistantFallbackAnswer,
  detectProjectAssistantQueryIntent,
  mergeProjectAssistantQueryIntents,
  projectAssistantRagCategories,
  shouldPlanProjectAssistantQuery,
} from "@/lib/project-assistant-query";
import { queryRagLite } from "@/lib/raglite-client";
import { requireUser } from "@/lib/server-auth";
import { buildDocumentAssistantContext, type DocumentExtractionResult } from "@/lib/assistant-document-processing";
import { isDocumentRevisionRequest, reviseDocumentsWithSmallModel } from "@/lib/assistant-document-revision";
import { buildAssistantSuggestions } from "@/lib/assistant-suggestions";

type StoredMessage = {
  id: string;
  role: string;
  content: string;
  source: string;
  trace: string;
  blocks: string;
  createdAt: Date;
};

const parseJsonArray = (value: string) => {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const parseJsonObject = (value: string) => {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const serializeMessage = (message: StoredMessage) => ({
  id: message.id,
  role: message.role,
  content: message.content,
  source: message.source || undefined,
  trace: parseJsonObject(message.trace),
  blocks: parseJsonArray(message.blocks),
  createdAt: message.createdAt.toISOString(),
});

const publicRuntime = (
  runtime: Awaited<ReturnType<typeof loadAssistantRuntimeConfig>>,
  assistantAccessMode: unknown,
) => ({
  enabled: runtime.enabled,
  assistantName: runtime.assistantName,
  welcomeMessage: runtime.welcomeMessage,
  personaPreset: runtime.personaPreset,
  avatarPalette: runtime.avatarPalette,
  avatarStyle: runtime.avatarStyle,
  modelConfigured: Boolean(runtime.llmProvider),
  retrievalConfigured: Boolean(runtime.retrievalEnabled && runtime.ragliteBaseUrl && runtime.embeddingProvider),
  agentEnabled: runtime.agentEnabled,
  assistantAccessMode: normalizeAssistantAccessMode(assistantAccessMode),
});

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if ("status" in user) return user;
  const runtime = await loadAssistantRuntimeConfig();
  const projectId = new URL(req.url).searchParams.get("projectId")?.trim() || "";
  const cutoff = new Date(Date.now() - runtime.historyRetentionDays * 86_400_000);
  await prisma.$transaction([
    prisma.assistantChatMessage.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.assistantActionRun.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.assistantPlanRun.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);
  const messages = await prisma.assistantChatMessage.findMany({
    where: { userId: user.userId, projectId },
    orderBy: { createdAt: "desc" },
    take: Math.max(40, runtime.historyLimit * 6),
    select: { id: true, role: true, content: true, source: true, trace: true, blocks: true, createdAt: true },
  });
  const actionIds = messages.flatMap((message) => parseJsonArray(message.blocks))
    .map((block) => block && typeof block === "object" && "action" in block
      ? String((block as { action?: { id?: unknown } }).action?.id || "")
      : "")
    .filter(Boolean);
  const actions = actionIds.length
    ? await prisma.assistantActionRun.findMany({ where: { id: { in: actionIds }, userId: user.userId } })
    : [];
  const planIds = Array.from(new Set(actions.map((action) => action.planId).filter((id): id is string => Boolean(id))));
  const plans = planIds.length
    ? await prisma.assistantPlanRun.findMany({ where: { id: { in: planIds }, userId: user.userId }, include: { steps: true } })
    : [];
  const planById = new Map(plans.map((plan) => [plan.id, serializeAssistantPlan(plan)]));
  const actionById = new Map(actions.map((action) => [action.id, {
    ...serializeAssistantAction(action),
    plan: action.planId ? planById.get(action.planId) : undefined,
  }]));
  const serializedMessages = [...messages].reverse().map(serializeMessage).map((message) => ({
    ...message,
    blocks: message.blocks.map((block) => {
      if (!block || typeof block !== "object" || !("action" in block)) return block;
      const current = (block as { action?: { id?: string } }).action;
      return current?.id && actionById.has(current.id)
        ? { ...block, type: actionById.get(current.id)?.status === "PROPOSED" ? "action-proposal" : "action-result", action: actionById.get(current.id) }
        : block;
    }),
  }));
  const suggestionContext = await buildProjectAssistantContext({ user, projectId }).catch(() => null);
  return ok({
    messages: serializedMessages,
    runtime: publicRuntime(runtime, user.assistantAccessMode),
    suggestions: buildAssistantSuggestions({
      context: suggestionContext,
      history: serializedMessages.map((message) => ({
        role: message.role === "assistant" ? "assistant" as const : "user" as const,
        content: message.content,
      })),
    }),
  });
}

export async function POST(req: NextRequest) {
  const requestStartedAt = Date.now();
  const user = await requireUser(req);
  if ("status" in user) return user;
  const runtime = await loadAssistantRuntimeConfig();
  if (!runtime.enabled) return err("智能助手已由管理员停用", 503);

  const body = await req.json().catch(() => ({})) as {
    message?: string;
    projectId?: string | null;
    history?: AssistantMessageInput[];
    attachmentIds?: string[];
  };
  const message = String(body.message || "").trim();
  if (!message) return err("请输入需要查询的内容");
  if (message.length > 2000) return err("单次提问不能超过 2000 个字");
  const projectId = String(body.projectId || "").trim();
  const history = Array.isArray(body.history)
    ? body.history.filter((item): item is AssistantMessageInput =>
      Boolean(item) && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
      .slice(-runtime.historyLimit)
    : [];
  const attachmentIds = Array.isArray(body.attachmentIds)
    ? Array.from(new Set(body.attachmentIds.map((value) => String(value || "").trim()).filter(Boolean))).slice(0, 5)
    : [];
  const attachments = attachmentIds.length > 0
    ? await prisma.assistantAttachment.findMany({
        where: { id: { in: attachmentIds }, userId: user.userId, projectId, status: "READY" },
        include: { extraction: true },
      })
    : [];
  if (attachments.length !== attachmentIds.length) return err("附件不存在、尚未解析完成或不属于当前项目", 400);
  const attachmentContexts = attachments.flatMap((attachment) => {
    if (!attachment.extraction) return [];
    const structured = parseJsonObject(attachment.extraction.structuredJson) ?? {};
    const diagnostics = parseJsonArray(attachment.extraction.diagnosticsJson);
    const extraction: DocumentExtractionResult = {
      format: String(structured.format || "text"),
      content: attachment.extraction.content,
      sections: Array.isArray(structured.sections) ? structured.sections as DocumentExtractionResult["sections"] : [],
      diagnostics: diagnostics as DocumentExtractionResult["diagnostics"],
      metadata: structured.metadata && typeof structured.metadata === "object" ? structured.metadata as Record<string, unknown> : {},
      truncated: Boolean(structured.truncated),
    };
    return [{ attachmentId: attachment.id, fileName: attachment.originalName, ...buildDocumentAssistantContext(extraction) }];
  });

  let answer = "";
  let source: "DATABASE" | "MODEL" | "RAG" | "MODEL_RAG" | "AGENT" | "SYSTEM" = "DATABASE";
  let blocks: unknown[] = [];
  let ragResult: Awaited<ReturnType<typeof queryRagLite>> = null;
  let retrievedChunks: Array<{ content: string; metadata?: Record<string, unknown> }> = [];
  const assistantAccessMode = normalizeAssistantAccessMode(user.assistantAccessMode);
  const manualContext = searchAssistantManual(message);
  const capabilityAnswer = buildAssistantCapabilityAnswer({
    message,
    runtime,
    attachments: attachments.map((attachment) => ({ fileName: attachment.originalName })),
  });

  const agentResolution = await resolveProjectAssistantAction({
    message,
    projectId,
    user,
    runtime,
    history,
    attachmentIds,
    allowModelPlanning: !capabilityAnswer,
    signal: req.signal,
  });
  let action = agentResolution.action;
  if (req.signal.aborted) return err("本次回答已终止", 499);
  const ruleIntent = detectProjectAssistantQueryIntent(message);
  const modelIntent = !action && shouldPlanProjectAssistantQuery(ruleIntent, message)
    ? await planProjectAssistantQueryWithModel({ message, history, runtime, signal: req.signal })
    : null;
  if (req.signal.aborted) return err("本次回答已终止", 499);
  const intent = mergeProjectAssistantQueryIntents(ruleIntent, modelIntent);
  const context = await buildProjectAssistantContext({ user, projectId });
  if (projectId && !context.project && !intent.identityOnly && !intent.domains.includes("GENERAL")) {
    return err("当前项目不存在", 404);
  }

  if (action) {
    if (shouldAutoExecuteAssistantAction(assistantAccessMode, action.riskLevel)) {
      const pendingAction = await prisma.assistantActionRun.findFirst({
        where: { id: action.id, userId: user.userId },
      });
      if (pendingAction) {
        try {
          const execution = await executeAssistantActionAndAdvancePlan(pendingAction, user);
          action = execution.nextAction ?? execution.action;
        } catch {
          const failedAction = await prisma.assistantActionRun.findUniqueOrThrow({
            where: { id: pendingAction.id },
          });
          action = serializeAssistantAction(failedAction);
        }
      }
    }
    const actionResultMessage = typeof action.result?.message === "string" ? action.result.message : "";
    answer = action.status === "PROPOSED"
      ? `已生成操作建议：**${action.title}**。请核对操作内容后确认执行。`
      : action.status === "SUCCEEDED"
        ? `已执行：**${action.title}**。${actionResultMessage}`
        : `操作未完成：**${action.title}**。${actionResultMessage || "请查看操作结果。"}`;
    source = "AGENT";
    blocks = [{ type: action.status === "PROPOSED" ? "action-proposal" : "action-result", action }];
  } else {
    const ragCategories = projectAssistantRagCategories(intent);
    ragResult = !intent.identityOnly && context.project?.id && ragCategories.length > 0
      ? await queryRagLite({
          query: message,
          projectId: context.project.id,
          categories: ragCategories,
        }, runtime, req.signal)
      : null;
    retrievedChunks = ragResult?.chunks ?? [];
    if (req.signal.aborted) return err("本次回答已终止", 499);

    answer = capabilityAnswer || (attachmentContexts.length > 0 && isDocumentRevisionRequest(message)
      ? await reviseDocumentsWithSmallModel({
          message,
          documents: attachmentContexts.map((attachment) => ({
            attachmentId: String(attachment.attachmentId),
            fileName: String(attachment.fileName),
            format: String(attachment.format),
            diagnostics: Array.isArray(attachment.diagnostics) ? attachment.diagnostics : [],
            content: String(attachment.content || ""),
          })),
          runtime,
          signal: req.signal,
        }) || ""
      : await callProjectAssistantModel({
          message,
          history,
          context,
          rag: ragResult,
          runtime,
          intent,
          attachments: attachmentContexts,
          manualContext,
          signal: req.signal,
        }) || "");
    if (req.signal.aborted) return err("本次回答已终止", 499);
    if (answer) source = capabilityAnswer ? "SYSTEM" : retrievedChunks.length ? "MODEL_RAG" : "MODEL";
    if (!answer && ragResult?.answer) {
      answer = ragResult.answer.trim();
      if (answer) source = "RAG";
    }
    if (!answer && manualContext) {
      answer = `根据佳佳本地使用手册：\n\n${manualContext}`;
      source = "SYSTEM";
    }
    if (!answer) {
      const fallback = buildProjectAssistantFallbackAnswer({
        message,
        intent,
        context,
        assistantName: runtime.assistantName,
      });
      answer = fallback.answer;
      source = fallback.source;
    }
  }

  const baseTrace = buildProjectAssistantAnswerTrace({
    intent,
    context,
    rag: ragResult,
    providerName: runtime.llmProvider?.name,
    modelName: runtime.llmProvider?.model,
    fallbackUsed: !["MODEL", "MODEL_RAG", "RAG"].includes(source),
  });
  const trace = {
    ...baseTrace,
    evidence: [
      ...(baseTrace.evidence ?? []),
      ...(manualContext ? [{ source: "佳佳本地使用手册", detail: "操作说明优先依据本地能力手册" }] : []),
      ...(capabilityAnswer ? [{ source: "佳佳服务端能力目录", detail: "能力结论来自当前已启用工具和附件约束" }] : []),
    ],
    projectId: context.project?.id ?? null,
    projectName: context.project?.name ?? null,
    source,
    agent: {
      ...agentResolution.trace,
      plan: agentResolution.plan ? {
        id: agentResolution.plan.id,
        title: agentResolution.plan.title,
        status: agentResolution.plan.status,
        stepCount: agentResolution.plan.steps.length,
      } : undefined,
      action: action ? {
        id: action.id,
        toolId: action.toolId,
        riskLevel: action.riskLevel,
        status: action.status,
      } : undefined,
    },
    durationMs: Date.now() - requestStartedAt,
  };

  const [userMessage, assistantMessage] = await prisma.$transaction(async (tx) => {
    const storedUser = await tx.assistantChatMessage.create({
      data: {
        userId: user.userId,
        username: user.username,
        displayName: user.displayName,
        projectId,
        role: "user",
        content: message,
        blocks: JSON.stringify(attachments.map((attachment) => ({
          type: "attachment",
          attachment: { id: attachment.id, name: attachment.originalName, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes },
        }))),
      },
      select: { id: true, role: true, content: true, source: true, trace: true, blocks: true, createdAt: true },
    });
    const storedAssistant = await tx.assistantChatMessage.create({
      data: {
        userId: user.userId,
        username: user.username,
        displayName: user.displayName,
        projectId,
        role: "assistant",
        content: answer,
        source,
        trace: JSON.stringify(trace),
        blocks: JSON.stringify(blocks),
      },
      select: { id: true, role: true, content: true, source: true, trace: true, blocks: true, createdAt: true },
    });
    if (action) {
      await tx.assistantActionRun.update({
        where: { id: action.id },
        data: { messageId: storedAssistant.id },
      });
    }
    return [storedUser, storedAssistant];
  });

  return ok({
    answer,
    source,
    userMessage: serializeMessage(userMessage),
    assistantMessage: serializeMessage(assistantMessage),
    runtime: publicRuntime(runtime, user.assistantAccessMode),
    suggestions: buildAssistantSuggestions({
      context,
      history: [...history, { role: "user", content: message }, { role: "assistant", content: answer }],
    }),
  });
}
