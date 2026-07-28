export type GanttHierarchyDirection = "INDENT" | "OUTDENT";

export interface GanttHierarchyTask {
  id: string;
  parentId?: string | null;
  sortOrder: number;
  createdAt?: Date | string;
}

const compareCreatedAt = (left?: Date | string, right?: Date | string) => {
  const leftValue = left ? new Date(left).getTime() : 0;
  const rightValue = right ? new Date(right).getTime() : 0;
  return leftValue - rightValue;
};

const comparePosition = (left: GanttHierarchyTask, right: GanttHierarchyTask) => (
  left.sortOrder - right.sortOrder
  || compareCreatedAt(left.createdAt, right.createdAt)
  || left.id.localeCompare(right.id)
);

const parentKey = (parentId?: string | null) => parentId ?? "";

const orderedSiblingIds = <T extends GanttHierarchyTask>(tasks: Map<string, T>, parentId: string | null) => (
  [...tasks.values()]
    .filter((task) => parentKey(task.parentId) === parentKey(parentId))
    .sort(comparePosition)
    .map((task) => task.id)
);

const flattenHierarchyIds = <T extends GanttHierarchyTask>(tasks: Map<string, T>) => {
  const result: string[] = [];
  const visited = new Set<string>();

  const visit = (taskId: string) => {
    if (visited.has(taskId)) return;
    visited.add(taskId);
    result.push(taskId);
    orderedSiblingIds(tasks, taskId).forEach(visit);
  };

  orderedSiblingIds(tasks, null).forEach(visit);
  [...tasks.keys()].filter((id) => !visited.has(id)).sort().forEach(visit);
  return result;
};

const selectedHierarchyRoots = <T extends GanttHierarchyTask>(
  tasks: Map<string, T>,
  selectedTaskIds: string[],
) => {
  const selected = new Set(selectedTaskIds.filter((id) => tasks.has(id)));
  return flattenHierarchyIds(tasks).filter((taskId) => {
    if (!selected.has(taskId)) return false;
    let currentParentId = tasks.get(taskId)?.parentId ?? null;
    while (currentParentId) {
      if (selected.has(currentParentId)) return false;
      currentParentId = tasks.get(currentParentId)?.parentId ?? null;
    }
    return true;
  });
};

const setSiblingOrder = <T extends GanttHierarchyTask>(
  tasks: Map<string, T>,
  siblingIds: string[],
  parentId: string | null,
) => {
  siblingIds.forEach((taskId, index) => {
    const task = tasks.get(taskId);
    if (!task) return;
    tasks.set(taskId, {
      ...task,
      parentId,
      sortOrder: index + 1,
    });
  });
};

export const changeGanttTaskHierarchy = <T extends GanttHierarchyTask>(
  sourceTasks: T[],
  selectedTaskIds: string[],
  direction: GanttHierarchyDirection,
) => {
  const original = new Map(sourceTasks.map((task) => [task.id, task]));
  const tasks = new Map(sourceTasks.map((task) => [task.id, { ...task }]));
  const selectedRoots = selectedHierarchyRoots(tasks, selectedTaskIds);
  const selectedRootSet = new Set(selectedRoots);
  const movedTaskIds: string[] = [];
  const outdentAnchorByParent = new Map<string, string>();

  for (const taskId of selectedRoots) {
    const task = tasks.get(taskId);
    if (!task) continue;

    if (direction === "INDENT") {
      const currentParentId = task.parentId ?? null;
      const siblings = orderedSiblingIds(tasks, currentParentId);
      const taskIndex = siblings.indexOf(taskId);
      const previousSiblingId = taskIndex > 0 ? siblings[taskIndex - 1] : null;
      if (!previousSiblingId || selectedRootSet.has(previousSiblingId)) continue;

      setSiblingOrder(tasks, siblings.filter((id) => id !== taskId), currentParentId);
      const newSiblings = orderedSiblingIds(tasks, previousSiblingId);
      setSiblingOrder(tasks, [...newSiblings, taskId], previousSiblingId);
      movedTaskIds.push(taskId);
      continue;
    }

    const oldParentId = task.parentId ?? null;
    if (!oldParentId) continue;
    const oldParent = tasks.get(oldParentId);
    if (!oldParent) continue;

    const oldSiblings = orderedSiblingIds(tasks, oldParentId).filter((id) => id !== taskId);
    setSiblingOrder(tasks, oldSiblings, oldParentId);

    const newParentId = oldParent.parentId ?? null;
    const targetSiblings = orderedSiblingIds(tasks, newParentId).filter((id) => id !== taskId);
    const anchorId = outdentAnchorByParent.get(oldParentId) ?? oldParentId;
    const anchorIndex = targetSiblings.indexOf(anchorId);
    const insertAt = anchorIndex >= 0 ? anchorIndex + 1 : targetSiblings.length;
    targetSiblings.splice(insertAt, 0, taskId);
    setSiblingOrder(tasks, targetSiblings, newParentId);
    outdentAnchorByParent.set(oldParentId, taskId);
    movedTaskIds.push(taskId);
  }

  const changedTasks = [...tasks.values()].filter((task) => {
    const previous = original.get(task.id);
    return previous && (
      (previous.parentId ?? null) !== (task.parentId ?? null)
      || previous.sortOrder !== task.sortOrder
    );
  });

  return {
    tasks: sourceTasks.map((task) => tasks.get(task.id) ?? task),
    changedTasks,
    movedTaskIds,
  };
};
