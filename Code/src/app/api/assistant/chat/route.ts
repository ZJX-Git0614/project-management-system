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
  buildProjectAssistantQueryIntent,
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
import {
  buildAssistantCompletedTraceEvents,
  buildAssistantIntentContract,
  composeVerifiedAssistantActionAnswer,
  verifyAssistantIntentCompletion,
  type AssistantGoalVerification,
} from "@/lib/assistant-intent-contract";
import { analyzeAssistantRequestWithModel } from "@/lib/assistant-request-planner";
import {
  encodeAssistantChatStreamEvent,
  type AssistantChatStreamEvent,
} from "@/lib/assistant-chat-stream";

type StoredMessage = {
  id: string;
  role: string;
  content: string;
  source: string;
  trace: string;
  blocks: string;
  createdAt: Date;
}

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
  if (!req.headers.get("accept")?.includes("application/x-ndjson")) {
    return handleAssistantChat(req);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const emit: AssistantChatEmitter = (event) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeAssistantChatStreamEvent(event)));
        } catch {
          closed = true;
        }
      };
      void (async () => {
        try {
          const response = await handleAssistantChat(req, emit);
          const payload = await response.json().catch(() => ({})) as {
            data?: Record<string, unknown>;
            error?: string;
          };
          if (!response.ok || !payload.data) {
            emit({ type: "error", error: payload.error || "助手暂时无法响应" });
          } else {
            emit({ type: "result", data: payload.data });
          }
        } catch (error) {
          if (!req.signal.aborted) {
            emit({
              type: "error",
              error: error instanceof Error ? error.message : "助手暂时无法响应",
            });
          }
        } finally {
          if (!closed) {
            closed = true;
            controller.close();
          }
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Content-Encoding": "identity",
      "X-Accel-Buffering": "no",
    },
  });
}

type AssistantChatEmitter = (event: AssistantChatStreamEvent) => void;

const handleAssistantChat = async (req: NextRequest, emit?: AssistantChatEmitter) => {
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
  emit?.({
    type: "trace",
    event: {
      id: "understand",
      phase: "UNDERSTAND",
      title: "理解用户要求",
      summary: "正在识别完整目标、交付物、限制条件和所需业务数据",
      status: "RUNNING",
    },
  });
  const baseIntentContract = buildAssistantIntentContract({ message, projectId });
  const intentContract = await analyzeAssistantRequestWithModel({
    message,
    projectId,
    history,
    runtime,
    baseContract: baseIntentContract,
    signal: req.signal,
  });
  emit?.({
    type: "trace",
    event: {
      id: "understand",
      phase: "UNDERSTAND",
      title: "理解用户要求",
      summary: intentContract.understanding || `识别到 ${intentContract.objectives.length} 个目标`,
      status: "SUCCEEDED",
      details: [
        ...intentContract.objectives.map((objective) => ({ label: "目标", value: objective.description })),
        ...intentContract.deliverables.map((deliverable) => ({ label: "交付物", value: deliverable.label })),
        ...intentContract.constraints.map((constraint) => ({ label: "约束", value: constraint })),
      ],
    },
  });
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
  let streamedAnswer = "";
  let source: "DATABASE" | "MODEL" | "RAG" | "MODEL_RAG" | "AGENT" | "SYSTEM" = "DATABASE";
  let blocks: unknown[] = [];
  let ragResult: Awaited<ReturnType<typeof queryRagLite>> = null;
  let retrievedChunks: Array<{ content: string; metadata?: Record<string, unknown> }> = [];
  const assistantAccessMode = normalizeAssistantAccessMode(user.assistantAccessMode);
  const manualContext = searchAssistantManual(message);
  let goalVerification: AssistantGoalVerification | undefined;
  const capabilityAnswer = buildAssistantCapabilityAnswer({
    message,
    runtime,
    attachments: attachments.map((attachment) => ({ fileName: attachment.originalName })),
  });

  emit?.({
    type: "trace",
    event: {
      id: "plan",
      phase: "PLAN",
      title: "制定执行计划",
      summary: "正在根据目标契约选择查询范围、工具和执行顺序",
      status: "RUNNING",
    },
  });
  const agentResolution = await resolveProjectAssistantAction({
    message,
    projectId,
    user,
    runtime,
    history,
    attachmentIds,
    intentContract,
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
  const semanticIntent = buildProjectAssistantQueryIntent(intentContract.queryDomains ?? []);
  const intent = mergeProjectAssistantQueryIntents(
    mergeProjectAssistantQueryIntents(ruleIntent, semanticIntent),
    modelIntent,
  );
  emit?.({
    type: "trace",
    event: {
      id: "plan",
      phase: "PLAN",
      title: "制定执行计划",
      summary: action
        ? `已选择白名单工具 ${action.toolId}${agentResolution.plan ? `，共 ${agentResolution.plan.steps.length} 个步骤` : ""}`
        : `将读取“${intent.label}”数据并生成完整回答`,
      status: "SUCCEEDED",
      toolId: action?.toolId,
      details: [
        { label: "查询范围", value: intent.domains.join("、") },
        ...(agentResolution.trace.decisionSummary
          ? [{ label: "工具决策", value: agentResolution.trace.decisionSummary }]
          : []),
      ],
    },
  });
  emit?.({
    type: "trace",
    event: {
      id: "observe",
      phase: "OBSERVE",
      title: "读取授权数据",
      summary: "正在按当前用户权限读取目标项目和相关业务模块",
      status: "RUNNING",
    },
  });
  const context = await buildProjectAssistantContext({
    user,
    projectId,
    includeResourceOptimization: intent.domains.includes("RESOURCE"),
  });
  if (projectId && !context.project && !intent.identityOnly && !intent.domains.includes("GENERAL")) {
    return err("当前项目不存在", 404);
  }
  emit?.({
    type: "trace",
    event: {
      id: "observe",
      phase: "OBSERVE",
      title: "读取授权数据",
      summary: context.project
        ? `已读取项目“${context.project.name}”的授权数据`
        : `已读取当前账号可访问的项目组合数据`,
      status: "SUCCEEDED",
      details: [
        { label: "甘特任务", value: String(context.progress.total) },
        { label: "项目事项", value: String(context.weeklyItems.length) },
        { label: "风险", value: String(context.risks.length) },
        { label: "文档", value: String(context.documents.length) },
      ],
    },
  });

  if (action) {
    emit?.({
      type: "trace",
      event: {
        id: "validate",
        phase: "VALIDATE",
        title: "校验权限与工具参数",
        summary: "正在校验当前账号权限、Agent 授权模式和结构化参数",
        status: "RUNNING",
        toolId: action.toolId,
      },
    });
    emit?.({
      type: "trace",
      event: {
        id: "validate",
        phase: "VALIDATE",
        title: "校验权限与工具参数",
        summary: "当前账号权限、工具白名单和参数 Schema 校验通过",
        status: "SUCCEEDED",
        toolId: action.toolId,
        details: agentResolution.trace.toolArgs
          ? [{ label: "结构化参数", value: JSON.stringify(agentResolution.trace.toolArgs) }]
          : undefined,
      },
    });
    emit?.({
      type: "trace",
      event: {
        id: "execute",
        phase: "EXECUTE",
        title: `调用 ${action.toolId}`,
        summary: shouldAutoExecuteAssistantAction(assistantAccessMode, action.riskLevel)
          ? "正在执行已授权操作"
          : "正在生成操作预览，等待用户确认后执行",
        status: "RUNNING",
        toolId: action.toolId,
      },
    });
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
    emit?.({
      type: "trace",
      event: {
        id: "execute",
        phase: "EXECUTE",
        title: `调用 ${action.toolId}`,
        summary: action.status === "PROPOSED"
          ? "操作预览已生成，等待用户确认"
          : typeof action.result?.message === "string"
            ? action.result.message
            : `工具状态：${action.status}`,
        status: action.status === "FAILED" ? "FAILED" : action.status === "PROPOSED" ? "RUNNING" : "SUCCEEDED",
        toolId: action.toolId,
      },
    });
    const actionResultMessage = typeof action.result?.message === "string" ? action.result.message : "";
    if (intentContract.exportIntent) {
      goalVerification = verifyAssistantIntentCompletion(intentContract, action);
      answer = composeVerifiedAssistantActionAnswer({
        contract: intentContract,
        action,
        verification: goalVerification,
      });
    } else {
      answer = action.status === "PROPOSED"
        ? `已生成操作建议：**${action.title}**。请核对操作内容后确认执行。`
        : action.status === "SUCCEEDED"
          ? `已执行：**${action.title}**。${actionResultMessage}`
          : `操作未完成：**${action.title}**。${actionResultMessage || "请查看操作结果。"}`;
    }
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
    if (retrievedChunks.length > 0) {
      emit?.({
        type: "trace",
        event: {
          id: "observe",
          phase: "OBSERVE",
          title: "读取授权数据",
          summary: `已读取实时业务数据，并检索到 ${retrievedChunks.length} 条相关知识片段`,
          status: "SUCCEEDED",
          details: [
            { label: "业务范围", value: intent.label },
            { label: "知识片段", value: String(retrievedChunks.length) },
          ],
        },
      });
    }
    if (req.signal.aborted) return err("本次回答已终止", 499);

    emit?.({
      type: "trace",
      event: {
        id: "synthesize",
        phase: "SYNTHESIZE",
        title: "整合结果",
        summary: "正在依据目标契约整合实时数据、知识片段和附件内容",
        status: "RUNNING",
      },
    });
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
          intentContract,
          onDelta: emit && !intent.identityOnly
            ? (delta) => {
                streamedAnswer += delta;
                emit({ type: "answer_delta", delta });
              }
            : undefined,
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

  if (emit && answer) {
    if (!streamedAnswer) {
      emit({ type: "answer_delta", delta: answer });
    } else if (streamedAnswer.trim() !== answer.trim()) {
      emit({ type: "answer_reset" });
      emit({ type: "answer_delta", delta: answer });
    }
  }
  goalVerification = verifyAssistantIntentCompletion(intentContract, action, { answer });
  emit?.({
    type: "trace",
    event: {
      id: "verify",
      phase: "VERIFY",
      title: "验收目标与交付物",
      summary: goalVerification.allRequiredPassed
        ? `已完成并验收 ${goalVerification.completedObjectives}/${goalVerification.requiredObjectives} 个必要目标`
        : `已完成 ${goalVerification.completedObjectives}/${goalVerification.requiredObjectives} 个必要目标${goalVerification.missingDeliverables.length ? `，待补充：${goalVerification.missingDeliverables.join("、")}` : ""}`,
      status: goalVerification.allRequiredPassed ? "SUCCEEDED" : action?.status === "PROPOSED" ? "RUNNING" : "FAILED",
      toolId: action?.toolId,
      details: goalVerification.objectives.map((objective) => ({
        label: objective.objectiveId,
        value: `${objective.status}：${objective.explanation}`,
      })),
    },
  });
  emit?.({
    type: "trace",
    event: {
      id: "synthesize",
      phase: "SYNTHESIZE",
      title: "整合结果",
      summary: "已将处理结果组织为最终回答和可交付内容",
      status: "SUCCEEDED",
    },
  });

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
      intentContract,
      goalVerification,
      events: buildAssistantCompletedTraceEvents({
        contract: intentContract,
        observation: agentResolution.trace.observation,
        action,
        verification: goalVerification,
        toolArgs: agentResolution.trace.toolArgs,
      }),
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
};
