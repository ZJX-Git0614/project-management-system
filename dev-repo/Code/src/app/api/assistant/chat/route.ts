import { NextRequest } from "next/server";

import { err, ok } from "@/lib/api-utils";
import { proposeAssistantAction, serializeAssistantAction } from "@/lib/assistant-actions";
import { callAssistantProviderModel } from "@/lib/assistant-provider-client";
import {
  assistantModelSystemPrompt,
  loadAssistantRuntimeConfig,
} from "@/lib/assistant-settings";
import { prisma } from "@/lib/prisma";
import {
  buildDatabaseAssistantAnswer,
  buildProjectAssistantContext,
  type AssistantMessageInput,
} from "@/lib/project-assistant";
import { queryRagLite } from "@/lib/raglite-client";
import { requireUser } from "@/lib/server-auth";

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

const publicRuntime = (runtime: Awaited<ReturnType<typeof loadAssistantRuntimeConfig>>) => ({
  enabled: runtime.enabled,
  assistantName: runtime.assistantName,
  welcomeMessage: runtime.welcomeMessage,
  personaPreset: runtime.personaPreset,
  avatarPalette: runtime.avatarPalette,
  avatarStyle: runtime.avatarStyle,
  modelConfigured: Boolean(runtime.llmProvider),
  retrievalConfigured: Boolean(runtime.retrievalEnabled && runtime.ragliteBaseUrl && runtime.embeddingProvider),
  agentEnabled: runtime.agentEnabled,
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
  const actionById = new Map(actions.map((action) => [action.id, serializeAssistantAction(action)]));
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
  return ok({
    messages: serializedMessages,
    runtime: publicRuntime(runtime),
  });
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if ("status" in user) return user;
  const runtime = await loadAssistantRuntimeConfig();
  if (!runtime.enabled) return err("智能助手已由管理员停用", 503);

  const body = await req.json().catch(() => ({})) as {
    message?: string;
    projectId?: string | null;
    history?: AssistantMessageInput[];
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
  const context = await buildProjectAssistantContext({ user, projectId });
  if (projectId && !context.project) return err("当前项目不存在", 404);

  let answer = "";
  let source = "DATABASE";
  let blocks: unknown[] = [];
  let retrievedChunks: Array<{ content: string; metadata?: Record<string, unknown> }> = [];

  const action = await proposeAssistantAction({ message, projectId, user, runtime });
  if (action) {
    answer = `已生成操作建议：**${action.title}**。请核对操作内容后确认执行。`;
    source = "AGENT";
    blocks = [{ type: "action-proposal", action }];
  } else {
    const ragResult = await queryRagLite({
      query: message,
      projectId: projectId || undefined,
      categories: ["project-document", "project-task", "weekly-item", "risk", "budget"],
    }, runtime, req.signal);
    retrievedChunks = ragResult?.chunks ?? [];

    if (runtime.llmProvider) {
      try {
        answer = await callAssistantProviderModel({
          provider: runtime.llmProvider,
          temperature: runtime.temperature,
          maxTokens: runtime.maxTokens,
          signal: req.signal,
          messages: [
            { role: "system", content: assistantModelSystemPrompt(runtime) },
            ...history,
            {
              role: "user",
              content: [
                `实时数据库上下文：${JSON.stringify(context).slice(0, 90_000)}`,
                retrievedChunks.length
                  ? `授权知识库片段：${JSON.stringify(retrievedChunks).slice(0, 35_000)}`
                  : "授权知识库片段：无",
                `用户问题：${message}`,
              ].join("\n\n"),
            },
          ],
        });
        source = retrievedChunks.length ? "MODEL_RAG" : "MODEL";
      } catch (error) {
        if (req.signal.aborted) return err("本次回答已终止", 499);
        console.error("[project-assistant] configured model failed", error);
      }
    }
    if (!answer && ragResult?.answer) {
      answer = ragResult.answer;
      source = "RAG";
    }
    if (!answer) {
      answer = buildDatabaseAssistantAnswer(message, context);
      source = "DATABASE";
    }
  }

  const trace = {
    projectId: context.project?.id ?? null,
    projectName: context.project?.name ?? null,
    source,
    provider: runtime.llmProvider?.name ?? null,
    model: runtime.llmProvider?.model ?? null,
    retrieved: retrievedChunks.slice(0, 8).map((chunk) => ({
      title: String(chunk.metadata?.fileName || chunk.metadata?.title || "知识库片段"),
      category: String(chunk.metadata?.category || ""),
    })),
    dataCounts: {
      tasks: context.progress.total,
      weeklyItems: context.weeklyItems.length,
      risks: context.risks.length,
      documents: context.documents.length,
    },
  };

  const [userMessage, assistantMessage] = await prisma.$transaction(async (tx) => {
    const storedUser = await tx.assistantChatMessage.create({
      data: { userId: user.userId, username: user.username, displayName: user.displayName, projectId, role: "user", content: message },
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
    runtime: publicRuntime(runtime),
  });
}
