export interface GanttTaskCodeSource {
  id: string;
  parentId?: string | null;
  taskCode?: string | null;
  sortOrder: number;
  createdAt?: Date | string;
}

const TASK_CODE_PATTERN = /^Task(\d+)(?:\.(\d+))*$/;

const compareCreatedAt = (a?: Date | string, b?: Date | string) => {
  const left = a ? new Date(a).getTime() : 0;
  const right = b ? new Date(b).getTime() : 0;
  return left - right;
};

const compareTaskPosition = (a: GanttTaskCodeSource, b: GanttTaskCodeSource) => (
  a.sortOrder - b.sortOrder || compareCreatedAt(a.createdAt, b.createdAt) || a.id.localeCompare(b.id)
);

const codeSegments = (taskCode?: string | null): number[] => {
  if (!taskCode || !TASK_CODE_PATTERN.test(taskCode)) return [];
  return taskCode.replace(/^Task/, "").split(".").map(Number);
};

const compareTaskCode = (a: string, b: string) => {
  const left = codeSegments(a);
  const right = codeSegments(b);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }

  return a.localeCompare(b);
};

const codeDepth = (taskCode?: string | null) => codeSegments(taskCode).length;

const lastCodeSegment = (taskCode?: string | null) => {
  const segments = codeSegments(taskCode);
  return segments.at(-1) ?? null;
};

const expectedChildPrefix = (parentTaskCode: string | null) => (
  parentTaskCode ? `${parentTaskCode}.` : "Task"
);

const matchesSiblingCode = (taskCode: string | null | undefined, parentTaskCode: string | null) => {
  if (!taskCode) return false;
  if (!TASK_CODE_PATTERN.test(taskCode)) return false;
  const depth = codeDepth(taskCode);
  if (!parentTaskCode) return depth === 1;
  return taskCode.startsWith(expectedChildPrefix(parentTaskCode)) && depth === codeDepth(parentTaskCode) + 1;
};

const assignGanttTaskCodes = <T extends GanttTaskCodeSource>(
  tasks: T[],
  rewriteExisting: boolean,
): Array<T & { taskCode: string }> => {
  const taskById = new Map(tasks.map((task) => [task.id, { ...task, taskCode: task.taskCode ?? "" }]));
  const childrenByParent = new Map<string, T[]>();

  for (const task of tasks) {
    const parentKey = task.parentId ?? "";
    childrenByParent.set(parentKey, [...(childrenByParent.get(parentKey) ?? []), task]);
  }

  const visit = (parentId: string | null, parentTaskCode: string | null) => {
    const siblings = [...(childrenByParent.get(parentId ?? "") ?? [])].sort(compareTaskPosition);
    const used = new Set<number>();

    if (!rewriteExisting) {
      for (const sibling of siblings) {
        const current = taskById.get(sibling.id)!;
        if (matchesSiblingCode(current.taskCode, parentTaskCode)) {
          const segment = lastCodeSegment(current.taskCode);
          if (segment !== null) used.add(segment);
        }
      }
    }

    let cursor = 1;
    for (const sibling of siblings) {
      const current = taskById.get(sibling.id)!;
      if (rewriteExisting || !matchesSiblingCode(current.taskCode, parentTaskCode)) {
        while (used.has(cursor)) cursor += 1;
        current.taskCode = parentTaskCode ? `${parentTaskCode}.${cursor}` : `Task${cursor}`;
        used.add(cursor);
      }
      visit(sibling.id, current.taskCode);
    }
  };

  visit(null, null);

  return tasks.map((task) => taskById.get(task.id)! as T & { taskCode: string });
};

export const assignMissingGanttTaskCodes = <T extends GanttTaskCodeSource>(tasks: T[]): Array<T & { taskCode: string }> => (
  assignGanttTaskCodes(tasks, false)
);

export const renumberGanttTaskCodes = <T extends GanttTaskCodeSource>(tasks: T[]): Array<T & { taskCode: string }> => (
  assignGanttTaskCodes(tasks, true)
);

export const orderGanttTasksByHierarchy = <T extends GanttTaskCodeSource>(tasks: T[]): T[] => {
  const childrenByParent = new Map<string, T[]>();
  for (const task of tasks) {
    const parentKey = task.parentId ?? "";
    childrenByParent.set(parentKey, [...(childrenByParent.get(parentKey) ?? []), task]);
  }

  const sortSiblings = (siblings: T[]) => (
    [...siblings].sort((a, b) => {
      const positionCompare = compareTaskPosition(a, b);
      if (positionCompare !== 0) return positionCompare;
      const codeCompare = compareTaskCode(a.taskCode ?? "", b.taskCode ?? "");
      if (codeCompare !== 0) return codeCompare;
      return 0;
    })
  );

  const ordered: T[] = [];
  const visit = (parentId: string | null) => {
    for (const task of sortSiblings(childrenByParent.get(parentId ?? "") ?? [])) {
      ordered.push(task);
      visit(task.id);
    }
  };

  visit(null);
  return ordered;
};

export const nextGanttTaskCode = (
  tasks: GanttTaskCodeSource[],
  parentId: string | null,
) => {
  const normalized = assignMissingGanttTaskCodes(tasks);
  const parent = parentId ? normalized.find((task) => task.id === parentId) : null;
  const parentTaskCode = parent?.taskCode ?? null;
  const siblingCodes = normalized
    .filter((task) => (task.parentId ?? null) === parentId)
    .map((task) => task.taskCode)
    .filter((taskCode) => matchesSiblingCode(taskCode, parentTaskCode));
  const maxSegment = siblingCodes.reduce((max, taskCode) => Math.max(max, lastCodeSegment(taskCode) ?? 0), 0);

  return parentTaskCode ? `${parentTaskCode}.${maxSegment + 1}` : `Task${maxSegment + 1}`;
};
