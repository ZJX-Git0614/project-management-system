export interface ProjectRoleMembership {
  id: string;
  projectId: string;
  roleName: string;
  roleNames?: string[];
  project: {
    name: string;
  };
}

export interface AffectedProjectRoleChange {
  projectId: string;
  projectName: string;
  removedRoleNames: string[];
  membershipIds: string[];
}

export const normalizeRoleNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  ));
};

export const parseRoleNames = (value: string | string[] | null | undefined): string[] => {
  if (Array.isArray(value)) return normalizeRoleNames(value);
  if (!value) return [];
  try {
    return normalizeRoleNames(JSON.parse(value));
  } catch {
    return [];
  }
};

export const diffRoleNames = (previous: string[], next: string[]) => {
  const normalizedPrevious = normalizeRoleNames(previous);
  const normalizedNext = normalizeRoleNames(next);
  const previousSet = new Set(normalizedPrevious);
  const nextSet = new Set(normalizedNext);

  return {
    addedRoleNames: normalizedNext.filter((roleName) => !previousSet.has(roleName)),
    removedRoleNames: normalizedPrevious.filter((roleName) => !nextSet.has(roleName)),
  };
};

export const buildAffectedProjects = (
  memberships: ProjectRoleMembership[],
  removedRoleNames: string[],
): AffectedProjectRoleChange[] => {
  const removedRoleSet = new Set(removedRoleNames);
  const projects = new Map<string, AffectedProjectRoleChange>();

  memberships.forEach((membership) => {
    const membershipRoleNames = membership.roleNames?.length
      ? membership.roleNames
      : membership.roleName.split("、").filter(Boolean);
    const removedMembershipRoleNames = membershipRoleNames.filter((roleName) => removedRoleSet.has(roleName));
    if (removedMembershipRoleNames.length === 0) return;
    const current = projects.get(membership.projectId) ?? {
      projectId: membership.projectId,
      projectName: membership.project.name,
      removedRoleNames: [],
      membershipIds: [],
    };
    removedMembershipRoleNames.forEach((roleName) => {
      if (!current.removedRoleNames.includes(roleName)) current.removedRoleNames.push(roleName);
    });
    current.membershipIds.push(membership.id);
    projects.set(membership.projectId, current);
  });

  return Array.from(projects.values());
};

export const buildAccountRoleChangeConfirmation = ({
  displayName,
  previousRoleNames,
  nextRoleNames,
  memberships,
}: {
  displayName: string;
  previousRoleNames: string[];
  nextRoleNames: string[];
  memberships: ProjectRoleMembership[];
}) => {
  const { addedRoleNames, removedRoleNames } = diffRoleNames(previousRoleNames, nextRoleNames);
  if (addedRoleNames.length === 0 && removedRoleNames.length === 0) return "";

  const affectedProjects = buildAffectedProjects(memberships, removedRoleNames);
  const lines = [`确认修改账号「${displayName}」的角色？`];
  if (addedRoleNames.length > 0) lines.push(`新增角色：${addedRoleNames.join("、")}`);
  if (removedRoleNames.length > 0) lines.push(`移除角色：${removedRoleNames.join("、")}`);
  if (affectedProjects.length > 0) {
    lines.push("以下项目中的成员角色展示将同步更新：");
    affectedProjects.forEach((project) => {
      lines.push(`《${project.projectName}》：${project.removedRoleNames.join("、")}`);
    });
  }
  lines.push("账号权限将按保存后的全部角色取并集。");
  return lines.join("\n");
};
