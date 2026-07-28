import { NextRequest } from "next/server";

import { normalizeAssistantAccessMode } from "@/lib/assistant-access";
import { ok } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if ("status" in user) return user;
  return ok({ assistantAccessMode: normalizeAssistantAccessMode(user.assistantAccessMode) });
}

export async function PUT(req: NextRequest) {
  const user = await requireUser(req);
  if ("status" in user) return user;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const assistantAccessMode = normalizeAssistantAccessMode(body.assistantAccessMode);
  await prisma.userAccount.update({
    where: { id: user.userId },
    data: { assistantAccessMode },
  });
  return ok({ assistantAccessMode });
}
