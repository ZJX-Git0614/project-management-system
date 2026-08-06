import type { Prisma } from "@prisma/client";

import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { projectMemberAccountWhere } from "@/lib/project-member-accounts";
import type { AuthenticatedUser } from "@/lib/server-auth";

type ProjectAccessClient = Prisma.TransactionClient | typeof prisma;

export const hasProjectAccess = async (
  user: Pick<AuthenticatedUser, "userId" | "displayName" | "assignedRoleNames">,
  projectId: string,
  db: ProjectAccessClient = prisma,
) => {
  if (user.assignedRoleNames.includes(ADMIN_ROLE_NAME)) return true;
  return Boolean(await db.projectMember.findFirst({
    where: {
      projectId,
      ...projectMemberAccountWhere(user.userId, user.displayName),
    },
    select: { id: true },
  }));
};

export const assertProjectAccess = async (
  user: Pick<AuthenticatedUser, "userId" | "displayName" | "assignedRoleNames">,
  projectId: string,
  db: ProjectAccessClient = prisma,
) => {
  if (!await hasProjectAccess(user, projectId, db)) {
    throw new Error("无权访问该项目");
  }
};
