import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export const projectMemberAccountWhere = (
  accountId: string,
  displayName: string,
): Prisma.ProjectMemberWhereInput => ({
  OR: [
    { accountId },
    { accountId: null, personName: displayName },
  ],
});

export const resolveProjectMemberAccount = async ({
  accountId,
  personName,
}: {
  accountId?: string;
  personName?: string;
}) => {
  if (accountId) {
    return prisma.userAccount.findFirst({
      where: { id: accountId, enabled: true },
      select: { id: true, displayName: true, assignedRoleNames: true },
    });
  }

  if (!personName) return null;
  const accounts = await prisma.userAccount.findMany({
    where: { displayName: personName, enabled: true },
    take: 2,
    select: { id: true, displayName: true, assignedRoleNames: true },
  });
  return accounts.length === 1 ? accounts[0] : null;
};
