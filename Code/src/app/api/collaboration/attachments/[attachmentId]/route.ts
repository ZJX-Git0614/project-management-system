import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";

import { forbidden, notFound, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

const encodeContentDisposition = (fileName: string) => {
  const fallback = fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ attachmentId: string }> },
) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "collaboration-center:view")) return forbidden();
  const { attachmentId } = await params;
  const attachment = await prisma.collaborationAttachment.findFirst({
    where: {
      id: attachmentId,
      message: { thread: { participants: { some: { accountId: user.userId } } } },
    },
  });
  if (!attachment) return notFound("协同附件");
  try {
    const content = await readFile(attachment.storagePath);
    return new Response(content, {
      headers: {
        "Content-Type": attachment.mimeType,
        "Content-Length": String(content.byteLength),
        "Content-Disposition": encodeContentDisposition(attachment.originalName),
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return notFound("协同附件文件");
  }
}
