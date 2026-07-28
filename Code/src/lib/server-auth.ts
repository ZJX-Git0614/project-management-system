import { NextRequest } from "next/server";

import { getUserFromRequest, type JwtPayload } from "@/lib/auth";
import { forbidden, unauthorizedFromRequest } from "@/lib/api-utils";
import {
  ADMIN_ROLE_NAME,
  DEFAULT_PERMISSION_TREE,
  hasPermission,
  normalizePermissionTree,
  type PermissionTreeState,
} from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { normalizeAssistantAccessMode, type AssistantAccessMode } from "@/lib/assistant-access";

export type AuthenticatedUser = JwtPayload & {
  assignedRoleNames: string[];
  assistantAccessMode: AssistantAccessMode;
};

const parseRoles = (value: string) => {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

export async function getAuthenticatedUser(req: NextRequest): Promise<AuthenticatedUser | null> {
  const tokenUser = getUserFromRequest(req);
  if (!tokenUser) return null;
  const account = await prisma.userAccount.findUnique({
    where: { id: tokenUser.userId },
    select: { enabled: true, displayName: true, assignedRoleNames: true, assistantAccessMode: true },
  });
  if (!account?.enabled) return null;
  return {
    ...tokenUser,
    displayName: account.displayName,
    assignedRoleNames: parseRoles(account.assignedRoleNames),
    assistantAccessMode: normalizeAssistantAccessMode(account.assistantAccessMode),
  };
}

export async function userHasPermission(user: AuthenticatedUser, nodeKey: string) {
  if (user.assignedRoleNames.includes(ADMIN_ROLE_NAME)) return true;
  const stored = await prisma.permissionTree.findUnique({ where: { id: "default_tree" }, select: { data: true } });
  let parsed: unknown;
  try {
    parsed = stored?.data ? JSON.parse(stored.data) : DEFAULT_PERMISSION_TREE;
  } catch {
    parsed = DEFAULT_PERMISSION_TREE;
  }
  const tree = normalizePermissionTree(
    parsed && typeof parsed === "object" ? parsed as Partial<PermissionTreeState> : undefined,
  );
  return user.assignedRoleNames.some((roleName) => hasPermission(tree, roleName, nodeKey));
}

export async function requireUser(req: NextRequest) {
  return await getAuthenticatedUser(req) ?? unauthorizedFromRequest(req);
}

export async function requireSystemAdmin(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  return user.assignedRoleNames.includes(ADMIN_ROLE_NAME) ? user : forbidden();
}
