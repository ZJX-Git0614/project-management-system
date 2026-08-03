export type GanttHierarchyDirection = "INDENT" | "OUTDENT";

export interface GanttHierarchyTask {
  id: string;
  parentId?: string | null;
  sortOrder: number;
  createdAt?: Date | string;
}

export interface GanttHierarchyCategorizedTask extends GanttHierarchyTask {
  taskCategory: string;
  taskName: string;
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

export const changeGanttTaskHierarchy = <T extends GanttHierarchyTask>(
  sourceTasks: T[],
  selectedTaskIds: string[],
  direction: GanttHierarchyDirection,
) => {
  const original = new Map(sourceTasks.map((task) => [task.id, task]));
  const sourceById = new Map(sourceTasks.map((task) => [task.id, { ...task }]));
  const orderedIds = flattenHierarchyIds(sourceById);
  const selectedRoots = selectedHierarchyRoots(sourceById, selectedTaskIds);
  const selectedRootSet = new Set(selectedRoots);
  const depthById = new Map<string, number>();
  const resolveDepth = (taskId: string, visiting = new Set<string>()): number => {
    const cached = depthById.get(taskId);
    if (cached !== undefined) return cached;
    const parentId = sourceById.get(taskId)?.parentId ?? null;
    if (!parentId || !sourceById.has(parentId) || visiting.has(parentId)) {
      depthById.set(taskId, 0);
      return 0;
    }
    const depth = resolveDepth(parentId, new Set(visiting).add(taskId)) + 1;
    depthById.set(taskId, depth);
    return depth;
  };
  orderedIds.forEach((taskId) => resolveDepth(taskId));

  const depthDeltaById = new Map<string, number>();
  const movedTaskIds: string[] = [];

  for (const taskId of selectedRoots) {
    const task = sourceById.get(taskId);
    if (!task) continue;
    const taskDepth = depthById.get(taskId) ?? 0;

    if (direction === "INDENT") {
      const currentParentId = task.parentId ?? null;
      const siblings = orderedSiblingIds(sourceById, currentParentId);
      const taskIndex = siblings.indexOf(taskId);
      const previousSiblingId = taskIndex > 0 ? siblings[taskIndex - 1] : null;
      if (!previousSiblingId || selectedRootSet.has(previousSiblingId)) continue;
    } else if (taskDepth === 0) {
      continue;
    }

    const rootIndex = orderedIds.indexOf(taskId);
    const delta = direction === "INDENT" ? 1 : -1;
    for (let index = rootIndex; index < orderedIds.length; index += 1) {
      const branchTaskId = orderedIds[index];
      const branchDepth = depthById.get(branchTaskId) ?? 0;
      if (index > rootIndex && branchDepth <= taskDepth) break;
      depthDeltaById.set(branchTaskId, (depthDeltaById.get(branchTaskId) ?? 0) + delta);
    }
    movedTaskIds.push(taskId);
  }

  if (movedTaskIds.length === 0) {
    return { tasks: sourceTasks, changedTasks: [] as T[], movedTaskIds };
  }

  const tasks = new Map(sourceTasks.map((task) => [task.id, { ...task }]));
  const latestTaskAtDepth: string[] = [];
  const siblingCursor = new Map<string, number>();
  for (const taskId of orderedIds) {
    const task = tasks.get(taskId);
    if (!task) continue;
    const originalDepth = depthById.get(taskId) ?? 0;
    const desiredDepth = Math.max(0, Math.min(originalDepth + (depthDeltaById.get(taskId) ?? 0), latestTaskAtDepth.length));
    const parentId = desiredDepth > 0 ? latestTaskAtDepth[desiredDepth - 1] ?? null : null;
    const key = parentKey(parentId);
    const sortOrder = (siblingCursor.get(key) ?? 0) + 1;
    siblingCursor.set(key, sortOrder);
    tasks.set(taskId, { ...task, parentId, sortOrder });
    latestTaskAtDepth[desiredDepth] = taskId;
    latestTaskAtDepth.length = desiredDepth + 1;
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

const categoryLeaf = (task: Pick<GanttHierarchyCategorizedTask, "taskCategory" | "taskName">) => (
  task.taskCategory
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1)
  || task.taskName.trim()
);

/**
 * Rebuilds only the moved branches' category paths after a hierarchy change.
 * The terminal category is retained while obsolete ancestor segments are replaced.
 */
export const synchronizeGanttTaskCategories = <T extends GanttHierarchyCategorizedTask>(
  tasks: T[],
  movedRootTaskIds: string[],
): T[] => {
  if (movedRootTaskIds.length === 0) return tasks;

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const childIdsByParentId = new Map<string, string[]>();
  tasks.forEach((task) => {
    if (!task.parentId) return;
    childIdsByParentId.set(task.parentId, [...(childIdsByParentId.get(task.parentId) ?? []), task.id]);
  });

  const affectedTaskIds = new Set<string>();
  const visitChildren = (taskId: string) => {
    if (affectedTaskIds.has(taskId) || !taskById.has(taskId)) return;
    affectedTaskIds.add(taskId);
    (childIdsByParentId.get(taskId) ?? []).forEach(visitChildren);
  };
  movedRootTaskIds.forEach(visitChildren);

  const resolvedCategories = new Map<string, string>();
  const resolveCategory = (taskId: string, visiting = new Set<string>()): string => {
    const cached = resolvedCategories.get(taskId);
    if (cached !== undefined) return cached;
    const task = taskById.get(taskId);
    if (!task) return "";
    if (!affectedTaskIds.has(taskId)) return task.taskCategory.trim();
    if (visiting.has(taskId)) return categoryLeaf(task);

    const ownCategory = categoryLeaf(task);
    const parentCategory = task.parentId
      ? resolveCategory(task.parentId, new Set(visiting).add(taskId))
      : "";
    const nextCategory = parentCategory && ownCategory
      ? `${parentCategory} / ${ownCategory}`
      : ownCategory || parentCategory;
    resolvedCategories.set(taskId, nextCategory);
    return nextCategory;
  };

  return tasks.map((task) => (
    affectedTaskIds.has(task.id)
      ? { ...task, taskCategory: resolveCategory(task.id) }
      : task
  ));
};

/** Keeps category paths aligned when a task name used as a category segment changes. */
export const synchronizeGanttTaskCategoriesAfterNameChange = <T extends GanttHierarchyCategorizedTask>(
  tasks: T[],
  taskId: string,
  previousName: string,
  nextName: string,
): T[] => {
  const before = previousName.trim();
  const after = nextName.trim();
  if (!after || before === after) return tasks;

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  if (!taskById.has(taskId)) return tasks;

  const childIdsByParentId = new Map<string, string[]>();
  tasks.forEach((task) => {
    if (!task.parentId) return;
    childIdsByParentId.set(task.parentId, [...(childIdsByParentId.get(task.parentId) ?? []), task.id]);
  });

  const affectedTaskIds = new Set<string>();
  const visit = (id: string) => {
    if (affectedTaskIds.has(id)) return;
    affectedTaskIds.add(id);
    (childIdsByParentId.get(id) ?? []).forEach(visit);
  };
  visit(taskId);

  return tasks.map((task) => {
    if (!affectedTaskIds.has(task.id)) return task;

    const category = task.taskCategory.trim();
    if (!before) {
      return task.id === taskId && !category
        ? { ...task, taskCategory: after }
        : task;
    }

    const nextCategory = category
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .map((segment) => segment === before ? after : segment)
      .join(" / ");
    return nextCategory !== category ? { ...task, taskCategory: nextCategory } : task;
  });
};
