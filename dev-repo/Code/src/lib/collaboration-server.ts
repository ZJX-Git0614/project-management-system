import { Prisma } from "@prisma/client";

import { TodoType } from "@/domain/enums";
import { assertProjectAccess } from "@/lib/project-access";
import { prisma } from "@/lib/prisma";
import type { AuthenticatedUser } from "@/lib/server-auth";

const THREAD_INCLUDE = {
  project: { select: { id: true, name: true, code: true } },
  participants: { orderBy: { createdAt: "asc" as const } },
  messages: { orderBy: { createdAt: "desc" as const }, take: 1 },
} satisfies Prisma.CollaborationThreadInclude;

export const collaborationMentionTodoWhere = (threadId: string, accountId: string) => ({
  collaborationThreadId: threadId,
  targetAccountId: accountId,
  type: TodoType.COLLABORATION_MENTION,
  status: "OPEN",
}) satisfies Prisma.TodoItemWhereInput;

export const collaborationNotificationWhere = (
  threadId: string,
  accountId: string,
  legacyMessageIds: string[] = [],
) => ({
  accountId,
  status: "UNREAD",
  OR: [
    { sourceType: "COLLABORATION_THREAD", sourceId: threadId },
    ...(legacyMessageIds.length > 0
      ? [{ sourceType: "COLLABORATION_MESSAGE", sourceId: { in: legacyMessageIds } }]
      : []),
  ],
}) satisfies Prisma.SystemNotificationWhereInput;

export const listCollaborationThreads = async (accountId: string, projectId?: string) => prisma.collaborationThread.findMany({
  where: {
    ...(projectId ? { projectId } : {}),
    participants: { some: { accountId } },
  },
  orderBy: { lastMessageAt: "desc" },
  include: THREAD_INCLUDE,
  take: 200,
});

export const getCollaborationThreadForUser = async (threadId: string, accountId: string) => prisma.collaborationThread.findFirst({
  where: { id: threadId, participants: { some: { accountId } } },
  include: {
    ...THREAD_INCLUDE,
    messages: {
      orderBy: { createdAt: "asc" },
      include: { attachments: true, mentions: true, replyTo: { select: { id: true, senderName: true, content: true } } },
      take: 500,
    },
  },
});

export const createCollaborationThread = async (params: {
  projectId: string;
  title: string;
  entityType?: string;
  entityId?: string;
  participantAccountIds: string[];
  creator: AuthenticatedUser;
}) => prisma.$transaction(async (tx) => {
  const project = await tx.project.findUnique({ where: { id: params.projectId }, select: { id: true } });
  if (!project) throw new Error("项目不存在");
  await assertProjectAccess(params.creator, params.projectId, tx);
  const requestedIds = Array.from(new Set([params.creator.userId, ...params.participantAccountIds.filter(Boolean)]));
  const members = await tx.projectMember.findMany({
    where: { projectId: params.projectId, accountId: { in: requestedIds } },
    include: { account: { select: { id: true, displayName: true, enabled: true } } },
  });
  const participantMap = new Map<string, {
    accountId: string;
    displayName: string;
    projectMemberId: string | null;
  }>(members.flatMap((member) => member.account?.enabled ? [[member.account.id, {
    accountId: member.account.id,
    displayName: member.account.displayName,
    projectMemberId: member.id,
  }] as const] : []));
  if (!participantMap.has(params.creator.userId)) {
    participantMap.set(params.creator.userId, { accountId: params.creator.userId, displayName: params.creator.displayName, projectMemberId: null });
  }
  if (participantMap.size < 2) throw new Error("协同会话至少需要两名有效参与人");
  return tx.collaborationThread.create({
    data: {
      projectId: params.projectId,
      title: params.title.trim() || "项目协同会话",
      kind: "MANUAL",
      entityType: params.entityType || "",
      entityId: params.entityId || "",
      createdByAccountId: params.creator.userId,
      createdByName: params.creator.displayName,
      participants: {
        create: Array.from(participantMap.values()).map((participant) => ({
          ...participant,
          participantRole: participant.accountId === params.creator.userId ? "OWNER" : "MEMBER",
        })),
      },
      messages: {
        create: {
          projectId: params.projectId,
          senderAccountId: "system",
          senderName: "系统",
          messageType: "SYSTEM",
          content: `${params.creator.displayName} 创建了协同会话`,
        },
      },
    },
    include: THREAD_INCLUDE,
  });
});

export const postCollaborationMessage = async (params: {
  threadId: string;
  content: string;
  replyToId?: string;
  mentionAccountIds?: string[];
  sender: AuthenticatedUser;
}) => prisma.$transaction(async (tx) => {
  const thread = await tx.collaborationThread.findFirst({
    where: { id: params.threadId, participants: { some: { accountId: params.sender.userId } } },
    include: { participants: true },
  });
  if (!thread) throw new Error("协同会话不存在或无权访问");
  if (thread.closedAt) throw new Error("协同会话已关闭");
  const content = params.content.trim();
  if (!content) throw new Error("消息内容不能为空");
  const mentionIds = Array.from(new Set(params.mentionAccountIds ?? []))
    .filter((accountId) => accountId !== params.sender.userId)
    .filter((accountId) => thread.participants.some((participant) => participant.accountId === accountId));
  if (params.replyToId) {
    const reply = await tx.collaborationMessage.findFirst({ where: { id: params.replyToId, threadId: thread.id }, select: { id: true } });
    if (!reply) throw new Error("回复的消息不存在");
  }
  const message = await tx.collaborationMessage.create({
    data: {
      projectId: thread.projectId,
      threadId: thread.id,
      senderAccountId: params.sender.userId,
      senderName: params.sender.displayName,
      content,
      replyToId: params.replyToId || null,
      mentions: {
        create: thread.participants
          .filter((participant) => mentionIds.includes(participant.accountId))
          .map((participant) => ({ accountId: participant.accountId, displayName: participant.displayName })),
      },
    },
    include: { attachments: true, mentions: true, replyTo: { select: { id: true, senderName: true, content: true } } },
  });
  await tx.collaborationThread.update({ where: { id: thread.id }, data: { lastMessageAt: message.createdAt } });
  for (const participant of thread.participants.filter((item) => mentionIds.includes(item.accountId))) {
    await tx.systemNotification.create({
      data: {
        projectId: thread.projectId,
        accountId: participant.accountId,
        category: "协同沟通",
        title: `${params.sender.displayName} 在协同会话中提到了你`,
        detail: content,
        severity: "INFO",
        sourceType: "COLLABORATION_THREAD",
        sourceId: thread.id,
      },
    });
    await tx.todoItem.create({
      data: {
        projectId: thread.projectId,
        collaborationThreadId: thread.id,
        collaborationMessageId: message.id,
        targetAccountId: participant.accountId,
        title: "协同消息提及",
        detail: `${thread.title}：${content}`,
        targetRole: "",
        targetPersonName: participant.displayName,
        type: TodoType.COLLABORATION_MENTION,
      },
    });
  }
  return message;
});

export const markCollaborationThreadRead = async (threadId: string, accountId: string) => prisma.$transaction(async (tx) => {
  const participant = await tx.collaborationParticipant.findUnique({ where: { threadId_accountId: { threadId, accountId } } });
  if (!participant) throw new Error("协同会话不存在或无权访问");
  const now = new Date();
  await tx.collaborationParticipant.update({ where: { id: participant.id }, data: { lastReadAt: now } });
  await tx.collaborationMention.updateMany({
    where: { accountId, readAt: null, message: { threadId } },
    data: { readAt: now },
  });
  const messageIds = await tx.collaborationMessage.findMany({
    where: { threadId },
    select: { id: true },
  });
  await tx.systemNotification.updateMany({
    where: collaborationNotificationWhere(threadId, accountId, messageIds.map((message) => message.id)),
    data: { status: "READ", readAt: now },
  });
  await tx.todoItem.updateMany({
    where: collaborationMentionTodoWhere(threadId, accountId),
    data: { status: "DONE" },
  });
  return { readAt: now };
});

export { THREAD_INCLUDE };
