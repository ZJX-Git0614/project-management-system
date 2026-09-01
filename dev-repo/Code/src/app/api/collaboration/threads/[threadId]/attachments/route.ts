import { NextRequest } from "next/server";

import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import {
  removeStoredCollaborationAttachment,
  storeCollaborationAttachment,
} from "@/lib/collaboration-attachment-storage";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "collaboration-center:message")) return forbidden();
  const { threadId } = await params;
  const thread = await prisma.collaborationThread.findFirst({
    where: { id: threadId, participants: { some: { accountId: user.userId } } },
    select: { id: true, projectId: true, closedAt: true },
  });
  if (!thread) return err("协同会话不存在或无权访问", 404);
  if (thread.closedAt) return err("协同会话已关闭");

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return err("请选择要上传的附件");
  let stored: Awaited<ReturnType<typeof storeCollaborationAttachment>> | null = null;
  try {
    stored = await storeCollaborationAttachment(threadId, file);
    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.collaborationMessage.create({
        data: {
          projectId: thread.projectId,
          threadId,
          senderAccountId: user.userId,
          senderName: user.displayName,
          messageType: "ATTACHMENT",
          content: String(form.get("content") || "").trim() || `上传附件：${file.name}`,
          attachments: {
            create: {
              originalName: file.name,
              storedName: stored!.storedName,
              mimeType: file.type || "application/octet-stream",
              sizeBytes: file.size,
              storagePath: stored!.storagePath,
            },
          },
        },
        include: { attachments: true, mentions: true },
      });
      await tx.collaborationThread.update({ where: { id: threadId }, data: { lastMessageAt: created.createdAt } });
      return created;
    });
    return ok(message, 201);
  } catch (error) {
    if (stored) await removeStoredCollaborationAttachment(stored.storagePath).catch(() => undefined);
    return err(error instanceof Error ? error.message : "附件上传失败");
  }
}
