import { buildGanttOwnerRollups, type GanttOwnerTask } from "@/lib/gantt-owner-hierarchy";

const taskDepth = (taskId: string, byId: Map<string, GanttOwnerTask>) => {
  let depth = 0;
  let parentId = byId.get(taskId)?.parentId ?? null;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return depth;
};

export const planGanttOwnerMemberReplacement = (
  tasks: GanttOwnerTask[],
  removedMemberId: string,
  replacementMemberId: string | null,
) => {
  const ownerIdsForTask = (task: GanttOwnerTask) => (
    Array.isArray(task.ownerMemberIds)
      ? [...new Set(task.ownerMemberIds.filter(Boolean))]
      : task.ownerMemberId ? [task.ownerMemberId] : []
  );
  const originalOwnerByTaskId = new Map(tasks.map((task) => [task.id, ownerIdsForTask(task)]));
  const originalLegacyOwnerByTaskId = new Map(tasks.map((task) => [task.id, task.ownerMemberId]));
  const usesOwnerArraysByTaskId = new Map(tasks.map((task) => [task.id, Array.isArray(task.ownerMemberIds)]));
  const byId = new Map<string, GanttOwnerTask & { ownerMemberIds: string[] }>(tasks.map((task) => [
    task.id,
    {
      ...task,
      ownerMemberIds: (() => {
        const current = ownerIdsForTask(task);
        const hadRemovedOwner = current.includes(removedMemberId);
        const remaining = current.filter((id) => id !== removedMemberId);
        if (hadRemovedOwner && replacementMemberId && !remaining.includes(replacementMemberId)) {
          remaining.push(replacementMemberId);
        }
        return remaining;
      })(),
      ownerMemberId: null,
    },
  ] as [string, GanttOwnerTask & { ownerMemberIds: string[] }]));
  byId.forEach((task) => {
    task.ownerMemberId = task.ownerMemberIds.length === 1 ? task.ownerMemberIds[0] : null;
  });
  const childrenByParentId = new Map<string, GanttOwnerTask[]>();
  Array.from(byId.values()).forEach((task) => {
    if (!task.parentId) return;
    const children = childrenByParentId.get(task.parentId) ?? [];
    children.push(task);
    childrenByParentId.set(task.parentId, children);
  });

  const parents = Array.from(byId.values())
    .filter((task) => childrenByParentId.has(task.id))
    .sort((left, right) => taskDepth(right.id, byId) - taskDepth(left.id, byId));

  parents.forEach((parent) => {
    const rollups = buildGanttOwnerRollups(Array.from(byId.values()));
    const childOwnerIds = Array.from(new Set(
      (childrenByParentId.get(parent.id) ?? [])
        .flatMap((child) => rollups.get(child.id) ?? []),
    ));
    parent.ownerMemberIds = childOwnerIds;
    parent.ownerMemberId = childOwnerIds.length === 1 ? childOwnerIds[0] : null;
  });

  return Array.from(byId.values())
    .filter((task) => {
      if (!usesOwnerArraysByTaskId.get(task.id)) {
        return task.ownerMemberId !== originalLegacyOwnerByTaskId.get(task.id);
      }
      const before = originalOwnerByTaskId.get(task.id) ?? [];
      const after = task.ownerMemberIds ?? [];
      return before.length !== after.length || before.some((id, index) => id !== after[index]);
    })
    .map((task) => usesOwnerArraysByTaskId.get(task.id)
      ? {
          id: task.id,
          ownerMemberId: task.ownerMemberId,
          ownerMemberIds: task.ownerMemberIds ?? [],
        }
      : { id: task.id, ownerMemberId: task.ownerMemberId });
};
