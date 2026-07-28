import { NextRequest } from "next/server";

import { getUserFromRequest, type JwtPayload } from "@/lib/auth";
import { forbidden, unauthorizedFromRequest } from "@/lib/api-utils";
import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

export type AuthenticatedUser = JwtPayload & {
  assignedRoleNames: string[];
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
    select: { enabled: true, displayName: true, assignedRoleNames: true },
  });
  if (!account?.enabled) return null;
  return {
    ...tokenUser,
    displayName: account.displayName,
    assignedRoleNames: parseRoles(account.assignedRoleNames),
  };
}

export async function requireUser(req: NextRequest) {
  return await getAuthenticatedUser(req) ?? unauthorizedFromRequest(req);
}

export async function requireSystemAdmin(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  return user.assignedRoleNames.includes(ADMIN_ROLE_NAME) ? user : forbidden();
}
