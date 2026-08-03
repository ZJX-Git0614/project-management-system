import type { AuthenticatedUser } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { projectMemberAccountWhere } from "@/lib/project-member-accounts";

export const hasAssistantProjectAccess = async (user: AuthenticatedUser, projectId: string) => {
  if (user.assignedRoleNames.includes("管理员")) return true;
  return Boolean(await prisma.projectMember.findFirst({
    where: {
      projectId,
      ...projectMemberAccountWhere(user.userId, user.displayName),
    },
    select: { id: true },
  }));
};
