import type { ProjectGanttTask } from "@/domain/models";

export type GanttFilterKey =
  | "taskName"
  | "taskDescription"
  | "owner"
  | "durationDays"
  | "startDate"
  | "endDate"
  | "predecessor";

export type GanttFilterState = Partial<Record<GanttFilterKey, string[]>>;

const ownerNames = (task: ProjectGanttTask) => {
  const members = task.ownerMembers ?? (task.ownerMember ? [task.ownerMember] : []);
  return members.length > 0 ? members.map((member) => member.personName).join("、") : "未分配";
};

export const ganttFilterValue = (task: ProjectGanttTask, key: GanttFilterKey) => {
  switch (key) {
    case "taskName": return task.taskName.trim() || "(空白)";
    case "taskDescription": return task.taskDescription?.trim() || "(空白)";
    case "owner": return ownerNames(task);
    case "durationDays": return String(task.durationDays ?? 0);
    case "startDate": return task.startDate || "(空白)";
    case "endDate": return task.finishDate || "(空白)";
    case "predecessor": return task.predecessorTask?.trim() || "无";
  }
};

export const ganttFilterOptions = (
  tasks: ProjectGanttTask[],
  key: GanttFilterKey,
) => [...new Set(tasks.map((task) => ganttFilterValue(task, key)))]
  .sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));

export const filterGanttRowsWithAncestors = <T extends ProjectGanttTask>(
  tasks: T[],
  filters: GanttFilterState,
) => {
  const activeFilters = (Object.entries(filters) as Array<[GanttFilterKey, string[]]>)
    .filter(([, values]) => Array.isArray(values));
  if (activeFilters.length === 0) return tasks;

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const retainedIds = new Set<string>();
  tasks.forEach((task) => {
    const matches = activeFilters.every(([key, values]) => values.includes(ganttFilterValue(task, key)));
    if (!matches) return;
    let current: T | undefined = task;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      retainedIds.add(current.id);
      current = current.parentId ? taskById.get(current.parentId) : undefined;
    }
  });
  return tasks.filter((task) => retainedIds.has(task.id));
};
