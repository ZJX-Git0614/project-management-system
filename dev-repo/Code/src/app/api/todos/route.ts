import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";

import { ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser } from "@/lib/server-auth";

const todoHref = (todo: { approvalInstanceId: string | null; collaborationThreadId: string | null; type: string; projectId: string }) => {
  if (todo.approvalInstanceId) return `/approvals?instanceId=${encodeURIComponent(todo.approvalInstanceId)}`;
  if (todo.type === "COLLABORATION_MENTION" && todo.collaborationThreadId) {
    return `/collaboration?threadId=${encodeURIComponent(todo.collaborationThreadId)}`;
  }
  if (todo.type === "COLLABORATION_MENTION") return "/collaboration";
  return `/projects/${todo.projectId}`;
};

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  const isAdmin = user.assignedRoleNames.includes(ADMIN_ROLE_NAME);
  const targetRoles = [
    ...(user.assignedRoleNames.includes("项目经理") ? ["PROJECT_MANAGER"] : []),
    ...(user.assignedRoleNames.includes("项目成员") ? ["MEMBER"] : []),
  ];
  const projectTodoWhere: Prisma.TodoItemWhereInput = {
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

  const [projectTodos, systemNotifications, backupAlerts] = await Promise.all([
    prisma.todoItem.findMany({
      where: projectTodoWhere,
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
      take: 100,
      include: { project: { select: { id: true, name: true, code: true } } },
    }),
    prisma.systemNotification.findMany({
      where: {
        accountId: user.userId,
        status: "UNREAD",
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    isAdmin
      ? prisma.systemBackupRecord.findMany({
          where: { status: { in: ["FAILED", "PARTIAL"] }, notificationReadAt: null },
          orderBy: { createdAt: "desc" },
          take: 30,
          select: { id: true, createdAt: true, status: true, errorMessage: true },
        })
      : Promise.resolve([]),
  ]);

  return ok({
    projectTodos: projectTodos.map((todo) => ({
      id: todo.id,
      createdAt: todo.createdAt.toISOString(),
      dueAt: todo.dueAt?.toISOString() ?? null,
      title: todo.title,
      detail: todo.detail,
      type: todo.type,
      href: todoHref(todo),
      project: todo.project,
    })),
    notifications: [
      ...systemNotifications.map((notification) => ({
        id: notification.id,
        createdAt: notification.createdAt.toISOString(),
        category: notification.category,
        title: notification.title,
        detail: notification.detail,
        severity: notification.severity,
        href: notification.sourceType === "APPROVAL_INSTANCE"
          ? `/approvals?instanceId=${encodeURIComponent(notification.sourceId)}`
          : notification.sourceType === "COLLABORATION_THREAD"
            ? `/collaboration?threadId=${encodeURIComponent(notification.sourceId)}`
          : notification.sourceType === "COLLABORATION_MESSAGE"
            ? "/collaboration"
            : "/todos",
      })),
      ...backupAlerts.map((alert) => ({
        id: `backup:${alert.id}`,
        createdAt: alert.createdAt.toISOString(),
        category: "系统数据管理",
        title: alert.status === "FAILED" ? "数据库备份失败" : "公司云盘同步失败",
        detail: alert.errorMessage || "备份未完整完成，请在系统数据管理中检查记录。",
        severity: alert.status === "FAILED" ? "ERROR" : "WARNING",
        href: "/admin/data-cleanup#backups",
      })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  });
}
