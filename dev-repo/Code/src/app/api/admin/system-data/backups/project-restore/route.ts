import { NextRequest } from "next/server";

import { requireSuperAdmin } from "@/lib/admin-auth";
import { ok } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("response" in auth) return auth.response;
  const batches = await prisma.projectRestoreBatch.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
  return ok(batches.map((batch) => ({
    ...batch,
    createdAt: batch.createdAt.toISOString(),
    completedAt: batch.completedAt?.toISOString() ?? null,
    rolledBackAt: batch.rolledBackAt?.toISOString() ?? null,
    expiresAt: batch.expiresAt.toISOString(),
    projectIds: JSON.parse(batch.projectIds),
    projectNames: JSON.parse(batch.projectNames),
    summary: JSON.parse(batch.summary),
    canRollback: batch.status === "COMPLETED" && batch.expiresAt.getTime() > Date.now() && Boolean(batch.protectionSnapshotDir),
  })));
}
