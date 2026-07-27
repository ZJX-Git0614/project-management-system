import { NextRequest } from "next/server";

import { getUserFromRequest } from "@/lib/auth";
import { ok, unauthorized } from "@/lib/api-utils";
import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();
  const account = await prisma.userAccount.findUnique({
    where: { id: user.userId },
    select: { assignedRoleNames: true, displayName: true },
  });
  if (!account) return unauthorized();
  const roles = JSON.parse(account.assignedRoleNames || "[]") as string[];
  if (!roles.includes(ADMIN_ROLE_NAME)) return ok({ updatedCount: 0 });

  const result = await prisma.systemBackupRecord.updateMany({
    where: { status: { in: ["FAILED", "PARTIAL"] }, notificationReadAt: null },
    data: { notificationReadAt: new Date(), notificationReadBy: account.displayName },
  });
  return ok({ updatedCount: result.count });
}
