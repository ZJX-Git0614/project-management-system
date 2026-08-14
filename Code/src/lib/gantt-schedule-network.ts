import { isGanttFsDependency } from "@/lib/gantt-planning-rules";

export interface GanttScheduleNetworkDependency {
  predecessorTaskId: string;
  type?: number;
  lag?: number;
  lagFormat?: number;
}

export interface GanttScheduleNetworkTask {
  id: string;
  projectId?: string;
  parentId?: string | null;
  progress?: number;
  predecessorDependencies?: GanttScheduleNetworkDependency[];
}

export interface ExpandedGanttDependency extends GanttScheduleNetworkDependency {
  successorTaskId: string;
  sourcePredecessorTaskId: string;
  sourceSuccessorTaskId: string;
  expandedFromSummary: boolean;
}

export interface GanttLeafScheduleNetwork<TTask extends GanttScheduleNetworkTask> {
  tasks: TTask[];
  leafTaskIds: string[];
  dependencies: ExpandedGanttDependency[];
  entryLeafIdsBySummaryId: Map<string, string[]>;
}

const dependencyKey = (
  successorTaskId: string,
  dependency: GanttScheduleNetworkDependency,
) => [
  dependency.predecessorTaskId,
  successorTaskId,
  Number(dependency.type ?? 1),
  Number(dependency.lag ?? 0),
  Number(dependency.lagFormat ?? 7),
].join(":");

/**
 * Converts semantic WBS dependencies into the leaf execution network used by
 * CPM and resource scheduling. The original WBS rows remain unchanged in the
 * database and UI; only the calculation graph is expanded.
 */
export const buildGanttLeafScheduleNetwork = <TTask extends GanttScheduleNetworkTask>(
  tasks: TTask[],
): GanttLeafScheduleNetwork<TTask> => {
  const taskById = new Map(tasks.map((task) => [task.id, task] as const));
  const childrenByParentId = new Map<string, string[]>();
  tasks.forEach((task) => {
    if (!task.parentId) return;
    const parent = taskById.get(task.parentId);
    if (!parent || parent.projectId !== task.projectId) return;
    childrenByParentId.set(task.parentId, [
      ...(childrenByParentId.get(task.parentId) ?? []),
      task.id,
    ]);
  });

  const leafCache = new Map<string, string[]>();
  const leafDescendants = (taskId: string, visiting = new Set<string>()): string[] => {
    const cached = leafCache.get(taskId);
    if (cached) return cached;
    if (visiting.has(taskId)) return [];
    const task = taskById.get(taskId);
    if (!task) return [taskId];
    const childIds = childrenByParentId.get(taskId) ?? [];
    if (childIds.length === 0) {
      leafCache.set(taskId, [taskId]);
      return [taskId];
    }
    const nextVisiting = new Set(visiting).add(taskId);
    const leaves = [...new Set(childIds.flatMap((childId) => leafDescendants(childId, nextVisiting)))];
    leafCache.set(taskId, leaves);
    return leaves;
  };

  const entryLeafIdsBySummaryId = new Map<string, string[]>();
  const entryLeafDescendants = (taskId: string) => {
    const descendants = leafDescendants(taskId).filter((id) => taskById.has(id));
    if ((childrenByParentId.get(taskId) ?? []).length === 0) return descendants;
    const descendantSet = new Set(descendants);
    const entries = descendants.filter((leafId) => {
      const leaf = taskById.get(leafId);
      return !(leaf?.predecessorDependencies ?? []).some((dependency) => (
        isGanttFsDependency(dependency)
        && leafDescendants(dependency.predecessorTaskId).some((id) => descendantSet.has(id) && id !== leafId)
      ));
    });
    const result = entries.length > 0 ? entries : descendants;
    entryLeafIdsBySummaryId.set(taskId, result);
    return result;
  };

  const expandedDependencies: ExpandedGanttDependency[] = [];
  const seenDependencies = new Set<string>();
  tasks.forEach((sourceSuccessor) => {
    const successorLeafIds = entryLeafDescendants(sourceSuccessor.id);
    (sourceSuccessor.predecessorDependencies ?? []).forEach((dependency) => {
      const predecessorLeafIds = leafDescendants(dependency.predecessorTaskId);
      predecessorLeafIds.forEach((predecessorTaskId) => {
        successorLeafIds.forEach((successorTaskId) => {
          if (predecessorTaskId === successorTaskId) return;
          const expanded = {
            ...dependency,
            predecessorTaskId,
            successorTaskId,
            sourcePredecessorTaskId: dependency.predecessorTaskId,
            sourceSuccessorTaskId: sourceSuccessor.id,
            expandedFromSummary: predecessorTaskId !== dependency.predecessorTaskId
              || successorTaskId !== sourceSuccessor.id,
          } satisfies ExpandedGanttDependency;
          const key = dependencyKey(successorTaskId, expanded);
          if (seenDependencies.has(key)) return;
          seenDependencies.add(key);
          expandedDependencies.push(expanded);
        });
      });
    });
  });

  const dependenciesBySuccessorId = new Map<string, GanttScheduleNetworkDependency[]>();
  expandedDependencies.forEach((dependency) => {
    dependenciesBySuccessorId.set(dependency.successorTaskId, [
      ...(dependenciesBySuccessorId.get(dependency.successorTaskId) ?? []),
      {
        predecessorTaskId: dependency.predecessorTaskId,
        type: dependency.type,
        lag: dependency.lag,
        lagFormat: dependency.lagFormat,
      },
    ]);
  });

  const leafTaskIds = tasks
    .filter((task) => (childrenByParentId.get(task.id) ?? []).length === 0)
    .map((task) => task.id);
  const leafTaskIdSet = new Set(leafTaskIds);
  return {
    tasks: tasks.map((task) => ({
      ...task,
      predecessorDependencies: leafTaskIdSet.has(task.id)
        ? dependenciesBySuccessorId.get(task.id) ?? []
        : [],
    })),
    leafTaskIds,
    dependencies: expandedDependencies,
    entryLeafIdsBySummaryId,
  };
};
