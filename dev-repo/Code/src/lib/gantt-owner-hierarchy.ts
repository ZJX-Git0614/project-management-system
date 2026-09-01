export interface GanttOwnerTask {
  id: string;
  parentId: string | null;
  ownerMemberId: string | null;
  ownerMemberIds?: string[];
}

export interface GanttOwnerMemberIdentity {
  id: string;
  accountId?: string | null;
  personName?: string | null;
}

export interface GanttOwnerIdentity {
  identityKey: string;
  canonicalMemberId: string;
}

export type GanttOwnerIdentityIndex = ReadonlyMap<string, GanttOwnerIdentity>;

interface GanttOwnerTaskSource {
  id: string;
  parentId?: string | null;
  ownerMemberId?: string | null;
  ownerMemberIds?: string[];
}

const directOwnerIds = (task: GanttOwnerTaskSource) => (
  Array.isArray(task.ownerMemberIds)
    ? task.ownerMemberIds.filter(Boolean)
    : task.ownerMemberId ? [task.ownerMemberId] : []
);

const taskChildren = (tasks: GanttOwnerTask[]) => {
  const childrenByParentId = new Map<string, GanttOwnerTask[]>();
  tasks.forEach((task) => {
    if (!task.parentId) return;
    const children = childrenByParentId.get(task.parentId) ?? [];
    children.push(task);
    childrenByParentId.set(task.parentId, children);
  });
  return childrenByParentId;
};

const stableIdCompare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

const memberIdentityKey = (member: GanttOwnerMemberIdentity) => {
  const accountId = member.accountId?.trim();
  if (accountId) return `account:${accountId}`;
  const personName = member.personName?.trim();
  return personName ? `person:${personName}` : `member:${member.id}`;
};

export const buildGanttOwnerIdentityIndex = (
  members: GanttOwnerMemberIdentity[],
): GanttOwnerIdentityIndex => {
  const canonicalMemberIdByIdentity = new Map<string, string>();
  [...members]
    .sort((left, right) => stableIdCompare(left.id, right.id))
    .forEach((member) => {
      const identityKey = memberIdentityKey(member);
      if (!canonicalMemberIdByIdentity.has(identityKey)) {
        canonicalMemberIdByIdentity.set(identityKey, member.id);
      }
    });

  return new Map(members.map((member) => {
    const identityKey = memberIdentityKey(member);
    return [member.id, {
      identityKey,
      canonicalMemberId: canonicalMemberIdByIdentity.get(identityKey) ?? member.id,
    }];
  }));
};

const canonicalizeOwnerIds = (
  ownerMemberIds: string[],
  ownerIdentityIndex?: GanttOwnerIdentityIndex,
) => {
  const canonicalMemberIdByIdentity = new Map<string, string>();
  ownerMemberIds.forEach((ownerMemberId) => {
    const identity = ownerIdentityIndex?.get(ownerMemberId) ?? {
      identityKey: `member:${ownerMemberId}`,
      canonicalMemberId: ownerMemberId,
    };
    if (!canonicalMemberIdByIdentity.has(identity.identityKey)) {
      canonicalMemberIdByIdentity.set(identity.identityKey, identity.canonicalMemberId);
    }
  });
  return Array.from(canonicalMemberIdByIdentity.values());
};

export const buildGanttOwnerRollups = (
  tasks: GanttOwnerTask[],
  ownerIdentityIndex?: GanttOwnerIdentityIndex,
) => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const childrenByParentId = taskChildren(tasks);
  const ownerIdsByTaskId = new Map<string, string[]>();
  const resolving = new Set<string>();

  const resolve = (taskId: string): string[] => {
    const cached = ownerIdsByTaskId.get(taskId);
    if (cached) return cached;
    if (resolving.has(taskId)) return [];
    const task = byId.get(taskId);
    if (!task) return [];

    resolving.add(taskId);
    const children = childrenByParentId.get(taskId) ?? [];
    const childOwnerIds = canonicalizeOwnerIds(
      children.flatMap((child) => resolve(child.id)),
      ownerIdentityIndex,
    );
    const ownerIds = children.length > 0
      ? childOwnerIds
      : canonicalizeOwnerIds(directOwnerIds(task), ownerIdentityIndex);
    resolving.delete(taskId);
    ownerIdsByTaskId.set(taskId, ownerIds);
    return ownerIds;
  };

  tasks.forEach((task) => resolve(task.id));
  return ownerIdsByTaskId;
};

export const buildGanttUnassignedLeafTasksByParentId = <T extends GanttOwnerTaskSource>(tasks: T[]) => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const normalizedTasks = tasks.map((task) => ({
    id: task.id,
    parentId: task.parentId ?? null,
    ownerMemberId: task.ownerMemberId ?? null,
    ownerMemberIds: Array.isArray(task.ownerMemberIds) ? task.ownerMemberIds : undefined,
  }));
  const childrenByParentId = taskChildren(normalizedTasks);
  const ownerRollups = buildGanttOwnerRollups(normalizedTasks);
  const unassignedLeafTasksByParentId = new Map<string, T[]>();

  tasks.forEach((task) => {
    if ((childrenByParentId.get(task.id)?.length ?? 0) > 0) return;
    if ((ownerRollups.get(task.id)?.length ?? 0) > 0) return;

    let parentId = task.parentId;
    const visitedParentIds = new Set<string>();
    while (parentId && !visitedParentIds.has(parentId)) {
      visitedParentIds.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      const unassignedLeafTasks = unassignedLeafTasksByParentId.get(parentId) ?? [];
      unassignedLeafTasks.push(task);
      unassignedLeafTasksByParentId.set(parentId, unassignedLeafTasks);
      parentId = parent.parentId;
    }
  });

  return unassignedLeafTasksByParentId;
};

export const getGanttDescendantIds = (tasks: GanttOwnerTask[], taskId: string) => {
  const childrenByParentId = taskChildren(tasks);
  const descendantIds: string[] = [];
  const pending = [...(childrenByParentId.get(taskId) ?? [])];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    descendantIds.push(current.id);
    pending.push(...(childrenByParentId.get(current.id) ?? []));
  }
  return descendantIds;
};

export const planGanttOwnerChange = (
  tasks: GanttOwnerTask[],
  taskId: string,
  nextOwnerMemberId: string | null,
  ownerIdentityIndex?: GanttOwnerIdentityIndex,
) => {
  const originalOwnerByTaskId = new Map(tasks.map((task) => [task.id, task.ownerMemberId]));
  const byId = new Map(tasks.map((task) => [task.id, { ...task }]));
  const target = byId.get(taskId);
  if (!target) return [];

  target.ownerMemberId = nextOwnerMemberId;
  const descendantIds = getGanttDescendantIds(tasks, taskId);
  descendantIds.forEach((descendantId) => {
    const descendant = byId.get(descendantId);
    if (descendant) descendant.ownerMemberId = nextOwnerMemberId;
  });

  const mutableTasks = Array.from(byId.values());
  const childrenByParentId = taskChildren(mutableTasks);
  const synchronizeParent = (parentId: string) => {
    const parent = byId.get(parentId);
    if (!parent) return;
    const ownerRollups = buildGanttOwnerRollups(Array.from(byId.values()), ownerIdentityIndex);
    const childOwnerIds = canonicalizeOwnerIds(
      (childrenByParentId.get(parentId) ?? [])
        .flatMap((child) => ownerRollups.get(child.id) ?? []),
      ownerIdentityIndex,
    );
    parent.ownerMemberId = childOwnerIds.length === 1 ? childOwnerIds[0] : null;
  };

  let parentId = target.parentId;
  const visitedParents = new Set<string>();
  while (parentId && !visitedParents.has(parentId)) {
    visitedParents.add(parentId);
    synchronizeParent(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }

  return Array.from(byId.values())
    .filter((task) => task.ownerMemberId !== originalOwnerByTaskId.get(task.id))
    .map((task) => ({ id: task.id, ownerMemberId: task.ownerMemberId }));
};

export const planGanttOwnerHierarchyNormalization = (
  tasks: GanttOwnerTask[],
  ownerIdentityIndex?: GanttOwnerIdentityIndex,
) => {
  const ownerRollups = buildGanttOwnerRollups(tasks, ownerIdentityIndex);
  const childrenByParentId = taskChildren(tasks);

  return tasks.flatMap((task) => {
    if (!childrenByParentId.has(task.id)) return [];
    const ownerMemberIds = ownerRollups.get(task.id) ?? [];
    const normalizedOwnerMemberId = ownerMemberIds.length === 1 ? ownerMemberIds[0] : null;
    return normalizedOwnerMemberId === task.ownerMemberId
      ? []
      : [{ id: task.id, ownerMemberId: normalizedOwnerMemberId }];
  });
};

export const planGanttLegacyOwnerBackfill = (tasks: GanttOwnerTask[]) => {
  const byId = new Map(tasks.map((task) => [task.id, task]));

  return tasks.flatMap((task) => {
    if (directOwnerIds(task).length > 0) return [];
    let parentId = task.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      if (parent.ownerMemberId) {
        return [{ id: task.id, ownerMemberId: parent.ownerMemberId }];
      }
      parentId = parent.parentId;
    }
    return [];
  });
};

export const getEffectiveGanttOwnerMemberId = (
  tasks: GanttOwnerTask[],
  taskId: string,
  ownerIdentityIndex?: GanttOwnerIdentityIndex,
) => {
  const ownerMemberIds = buildGanttOwnerRollups(tasks, ownerIdentityIndex).get(taskId) ?? [];
  return ownerMemberIds.length === 1 ? ownerMemberIds[0] : null;
};
