import { readFile } from "node:fs/promises";

import { NextRequest, NextResponse } from "next/server";

import { getAssistantArtifactPath } from "@/lib/assistant-artifact-storage";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser } from "@/lib/server-auth";

export async function GET(req: NextRequest, { params }: { params: Promise<{ artifactId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({ success: false, error: "未登录" }, { status: 401 });
  const { artifactId } = await params;
  const artifact = await prisma.assistantArtifact.findFirst({ where: { id: artifactId, userId: user.userId } });
  if (!artifact) return NextResponse.json({ success: false, error: "修订稿不存在" }, { status: 404 });
  try {
    const content = await readFile(getAssistantArtifactPath(artifact.projectId, artifact.storedName));
    return new NextResponse(content, {
      headers: {
        "Content-Type": artifact.mimeType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`,
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: "修订稿文件已丢失" }, { status: 404 });
  }
}
