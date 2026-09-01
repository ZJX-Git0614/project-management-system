import type { NextRequest } from "next/server";

import { forbidden, unauthorized } from "@/lib/api-utils";
import { getUserFromRequest } from "@/lib/auth";
import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

export const requireSuperAdmin = async (req: NextRequest) => {
  const user = getUserFromRequest(req);
  if (!user) return { response: unauthorized() } as const;

  const account = await prisma.userAccount.findUnique({
    where: { id: user.userId },
    select: { enabled: true, displayName: true, assignedRoleNames: true },
  });
  if (!account?.enabled) return { response: unauthorized() } as const;

  let roleNames: string[] = [];
  try {
    const parsed = JSON.parse(account.assignedRoleNames);
    if (Array.isArray(parsed)) roleNames = parsed.filter((role): role is string => typeof role === "string");
  } catch {
    roleNames = [];
  }
  if (!roleNames.includes(ADMIN_ROLE_NAME)) return { response: forbidden() } as const;
  return { user: { ...user, displayName: account.displayName } } as const;
};
