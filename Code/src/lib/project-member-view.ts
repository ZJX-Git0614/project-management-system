import { parseRoleNames } from "@/lib/role-assignments";

type ProjectMemberWithAccount = {
  id: string;
  projectId: string;
  accountId: string | null;
  roleName: string;
  personName: string;
  createdAt: Date;
  updatedAt: Date;
  account?: {
    displayName: string;
    assignedRoleNames: string;
  } | null;
};

export const serializeProjectMember = (
  member: ProjectMemberWithAccount,
  validRoleNames: Set<string>,
) => {
  const currentRoleNames = member.account
    ? parseRoleNames(member.account.assignedRoleNames).filter((roleName) => validRoleNames.has(roleName))
    : [member.roleName].filter((roleName) => validRoleNames.has(roleName));
  const roleNames = Array.from(new Set(currentRoleNames));

  return {
    id: member.id,
    projectId: member.projectId,
    accountId: member.accountId,
    roleName: roleNames.join("、") || member.roleName,
    roleNames,
    personName: member.account?.displayName ?? member.personName,
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
  };
};

export const getValidProjectRoleNames = async (client: {
  roleConfig: {
    findMany: (args: { select: { roleName: true } }) => Promise<Array<{ roleName: string }>>;
  };
}) => new Set(
  (await client.roleConfig.findMany({ select: { roleName: true } })).map((role) => role.roleName),
);
