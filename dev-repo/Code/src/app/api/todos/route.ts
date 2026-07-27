import { NextRequest } from "next/server";

import { getUserFromRequest } from "@/lib/auth";
import { ok, unauthorized } from "@/lib/api-utils";
import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();
  const account = await prisma.userAccount.findUnique({
    where: { id: user.userId },
    select: { assignedRoleNames: true, displayName: true },
  });
  if (!account) return unauthorized();

  const roleNames = JSON.parse(account.assignedRoleNames || "[]") as string[];
  const isAdmin = roleNames.includes(ADMIN_ROLE_NAME);
  const targetRoles = [
    ...(roleNames.includes("项目经理") ? ["PROJECT_MANAGER"] : []),
    ...(roleNames.includes("项目成员") ? ["MEMBER"] : []),
  ];
  const projectTodoWhere = isAdmin
    ? { status: "OPEN" }
    : {
        status: "OPEN",
        OR: [
          { targetPersonName: account.displayName },
          ...(targetRoles.length > 0 ? [{ targetPersonName: null, targetRole: { in: targetRoles } }] : []),
        ],
      };

  const [projectTodos, backupAlerts] = await Promise.all([
    prisma.todoItem.findMany({
      where: projectTodoWhere,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { project: { select: { id: true, name: true, code: true } } },
    }),
    isAdmin
      ? prisma.systemBackupRecord.findMany({
          where: { status: { in: ["FAILED", "PARTIAL"] } },
          orderBy: { createdAt: "desc" },
          take: 30,
          select: {
            id: true,
            createdAt: true,
            triggerMode: true,
            status: true,
            cloudStatus: true,
            errorMessage: true,
          },
        })
      : Promise.resolve([]),
  ]);

  return ok({
    projectTodos: projectTodos.map((todo) => ({
      id: todo.id,
      createdAt: todo.createdAt.toISOString(),
      title: todo.title,
      detail: todo.detail,
      type: todo.type,
      project: todo.project,
    })),
    backupAlerts: backupAlerts.map((alert) => ({
      ...alert,
      createdAt: alert.createdAt.toISOString(),
    })),
  });
}
