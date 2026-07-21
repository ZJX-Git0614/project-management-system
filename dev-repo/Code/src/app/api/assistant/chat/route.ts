import { NextRequest } from "next/server"

import { getUserFromRequest } from "@/lib/auth"
import { err, ok, unauthorized } from "@/lib/api-utils"
import { prisma } from "@/lib/prisma"
import {
  buildDatabaseAssistantAnswer,
  buildProjectAssistantContext,
  callProjectAssistantModel,
  type AssistantMessageInput,
} from "@/lib/project-assistant"

const serializeMessage = (message: {
  id: string
  role: string
  content: string
  source: string
  createdAt: Date
}) => ({
  id: message.id,
  role: message.role,
  content: message.content,
  source: message.source || undefined,
  createdAt: message.createdAt.toISOString(),
})

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const projectId = new URL(req.url).searchParams.get("projectId")?.trim() || ""
  const messages = await prisma.assistantChatMessage.findMany({
    where: { userId: user.userId, projectId },
    orderBy: { createdAt: "desc" },
    take: 80,
    select: { id: true, role: true, content: true, source: true, createdAt: true },
  })

  return ok({
    messages: [...messages].reverse().map(serializeMessage),
    modelConfigured: Boolean(process.env.ASSISTANT_MODEL_BASE_URL && process.env.ASSISTANT_MODEL),
  })
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const body = await req.json().catch(() => ({})) as {
    message?: string
    projectId?: string | null
    history?: AssistantMessageInput[]
  }
  const message = String(body.message || "").trim()
  if (!message) return err("请输入需要查询的内容")
  if (message.length > 1000) return err("单次提问不能超过 1000 个字")

  const projectId = String(body.projectId || "").trim()
  const history = Array.isArray(body.history)
    ? body.history
        .filter((item): item is AssistantMessageInput =>
          Boolean(item)
          && (item.role === "user" || item.role === "assistant")
          && typeof item.content === "string")
        .slice(-8)
    : []
  const context = await buildProjectAssistantContext({ user, projectId })
  if (projectId && !context.project) return err("当前项目不存在", 404)

  let modelAnswer: string | null = null
  try {
    modelAnswer = await callProjectAssistantModel({
      message,
      history,
      context,
      signal: req.signal,
    })
  } catch (error) {
    if (req.signal.aborted) return err("本次回答已终止", 499)
    console.error("[project-assistant] 模型调用失败", error)
  }

  const answer = modelAnswer || buildDatabaseAssistantAnswer(message, context)
  const source = modelAnswer ? "MODEL" : "DATABASE"
  const [userMessage, assistantMessage] = await prisma.$transaction(async (tx) => {
    const storedUserMessage = await tx.assistantChatMessage.create({
      data: {
        userId: user.userId,
        username: user.username,
        displayName: user.displayName,
        projectId,
        role: "user",
        content: message,
      },
      select: { id: true, role: true, content: true, source: true, createdAt: true },
    })
    const storedAssistantMessage = await tx.assistantChatMessage.create({
      data: {
        userId: user.userId,
        username: user.username,
        displayName: user.displayName,
        projectId,
        role: "assistant",
        content: answer,
        source,
      },
      select: { id: true, role: true, content: true, source: true, createdAt: true },
    })
    return [storedUserMessage, storedAssistantMessage]
  })

  return ok({
    answer,
    source,
    userMessage: serializeMessage(userMessage),
    assistantMessage: serializeMessage(assistantMessage),
    scope: {
      projectId: context.project?.id ?? null,
      projectName: context.project?.name ?? null,
    },
  })
}
