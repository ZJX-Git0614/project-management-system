import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";

import { ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser } from "@/lib/server-auth";

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  const roleNames = user.assignedRoleNames;
  const isAdmin = roleNames.includes(ADMIN_ROLE_NAME);
  const targetRoles = [
    ...(roleNames.includes("项目经理") ? ["PROJECT_MANAGER"] : []),
    ...(roleNames.includes("项目成员") ? ["MEMBER"] : []),
  ];
  const where: Prisma.TodoItemWhereInput = {
    status: "OPEN",
    OR: [
      { targetAccountId: user.userId },
      {
        targetAccountId: null,
        OR: [
          { targetPersonName: user.displayName },
          ...(targetRoles.length > 0 ? [{ targetPersonName: null, targetRole: { in: targetRoles } }] : []),
        ],
      },
    ],
  };
  const [todoCount, systemNotificationCount, backupNotificationCount] = await Promise.all([
    prisma.todoItem.count({ where }),
    prisma.systemNotification.count({
      where: { accountId: user.userId, status: "UNREAD", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    }),
    isAdmin
      ? prisma.systemBackupRecord.count({ where: { status: { in: ["FAILED", "PARTIAL"] }, notificationReadAt: null } })
      : Promise.resolve(0),
  ]);
  const notificationCount = systemNotificationCount + backupNotificationCount;
  return ok({ count: todoCount + notificationCount, todoCount, notificationCount });
}
