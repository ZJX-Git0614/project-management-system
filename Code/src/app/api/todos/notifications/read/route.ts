import { NextRequest } from "next/server";

import { ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser } from "@/lib/server-auth";

export async function PUT(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  const now = new Date();
  const systemResult = await prisma.systemNotification.updateMany({
    where: { accountId: user.userId, status: "UNREAD" },
    data: { status: "READ", readAt: now },
  });
  let backupCount = 0;
  if (user.assignedRoleNames.includes(ADMIN_ROLE_NAME)) {
    const backupResult = await prisma.systemBackupRecord.updateMany({
      where: { status: { in: ["FAILED", "PARTIAL"] }, notificationReadAt: null },
      data: { notificationReadAt: now, notificationReadBy: user.displayName },
    });
    backupCount = backupResult.count;
  }
  return ok({ updatedCount: systemResult.count + backupCount });
}
