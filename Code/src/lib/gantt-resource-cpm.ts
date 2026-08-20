import {
  calculateGanttCpm,
  type CpmGanttDependency,
  type CpmGanttTask,
  type GanttCpmResult,
} from "@/lib/gantt-cpm";
import { isGanttFsDependency, normalizeGanttScheduleMode } from "@/lib/gantt-planning-rules";
import { abstractDateFromGanttOffset, isGanttRelativeOffset } from "@/lib/gantt-relative-time";

/**
 * A resource-aware CPM input. Resource links are derived from the final
 * schedule; they are not written back as user dependencies.
 */
export type ResourceCpmTask = CpmGanttTask & {
  projectId?: string;
  ownerKeys?: string[];
  ownerMemberIds?: string[];
  ownerMembers?: Array<{
    id?: string | null;
    accountId?: string | null;
    personName?: string | null;
  }>;
  isLeaf?: boolean;
  sortOrder?: number;
  relativeStartOffsetDays?: number | null;
  relativeFinishOffsetDays?: number | null;
  /** Client-facing list payloads may still expose dependency ids only. */
  predecessorTaskIds?: string[];
};

export interface ResourceCpmLink {
  predecessorTaskId: string;
  successorTaskId: string;
  ownerKey: string;
}

export interface ResourceAwareGanttCpmResult extends GanttCpmResult {
  resourceLinks: ResourceCpmLink[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const dateRangeIsValid = (task: ResourceCpmTask) => (
  DATE_PATTERN.test(task.startDate)
  && DATE_PATTERN.test(task.finishDate ?? "")
  && (task.finishDate ?? "") >= task.startDate
);

const ownerKeysFor = (task: ResourceCpmTask): string[] => {
  const explicitKeys = (task.ownerKeys ?? []).map((key) => String(key).trim()).filter(Boolean);
  if (explicitKeys.length > 0) return [...new Set(explicitKeys)];
  const directMemberKeys = (task.ownerMemberIds ?? [])
    .map((memberId) => String(memberId).trim())
    .filter(Boolean)
    .map((memberId) => `member:${memberId}`);
  if (directMemberKeys.length > 0) return [...new Set(directMemberKeys)];

  // List payloads from older API versions may omit ownerMemberIds while
  // retaining the rolled-up ownerMembers display objects. Use stable member
  // ids first, then account/person identity as a compatibility fallback.
  return [...new Set((task.ownerMembers ?? []).flatMap((owner) => {
    const id = String(owner.id ?? "").trim();
    if (id) return [`member:${id}`];
    const accountId = String(owner.accountId ?? "").trim();
    if (accountId) return [`account:${accountId}`];
    const personName = String(owner.personName ?? "").trim();
    return personName ? [`person:${personName}`] : [];
  }))];
};

const taskIsLeaf = (task: ResourceCpmTask, parentIds: Set<string>) => (
  task.isLeaf ?? !parentIds.has(task.id)
);

const taskOrder = (left: ResourceCpmTask, right: ResourceCpmTask) => (
  left.startDate.localeCompare(right.startDate)
  || (left.finishDate ?? "").localeCompare(right.finishDate ?? "")
  || (left.sortOrder ?? 0) - (right.sortOrder ?? 0)
  || left.id.localeCompare(right.id)
);

const dependencyKey = (predecessorTaskId: string, successorTaskId: string) => (
  `${predecessorTaskId}:${successorTaskId}`
);

const dependenciesFor = (task: ResourceCpmTask): CpmGanttDependency[] => {
  if ((task.predecessorDependencies?.length ?? 0) > 0) {
    return task.predecessorDependencies ?? [];
  }
  return [...new Set(task.predecessorTaskIds ?? [])]
    .filter((predecessorTaskId) => predecessorTaskId && predecessorTaskId !== task.id)
    .map((predecessorTaskId) => ({
      predecessorTaskId,
      type: 1,
      lag: 0,
      lagFormat: 7,
    }));
};

const materializeRelativeResourceDates = (tasks: ResourceCpmTask[]) => tasks.map((task) => {
  const hasRelativeStart = isGanttRelativeOffset(task.relativeStartOffsetDays);
  const hasRelativeFinish = isGanttRelativeOffset(task.relativeFinishOffsetDays);
  if (!hasRelativeStart && !hasRelativeFinish) return task;

  const startDate = hasRelativeStart
    ? abstractDateFromGanttOffset(task.relativeStartOffsetDays!)
    : task.startDate;
  const finishDate = hasRelativeFinish
    ? abstractDateFromGanttOffset(task.relativeFinishOffsetDays!)
    : hasRelativeStart && Number(task.durationDays) > 0
      ? abstractDateFromGanttOffset(
        task.relativeStartOffsetDays! + Math.max(0, Number(task.durationDays) - 1),
      )
      : task.finishDate;

  return { ...task, startDate, finishDate };
});

const dependencyFirstOrder = (tasks: ResourceCpmTask[]) => {
  const taskById = new Map(tasks.map((task) => [task.id, task] as const));
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  tasks.forEach((task) => {
    incoming.set(task.id, new Set());
    outgoing.set(task.id, new Set());
  });

  tasks.forEach((task) => {
    dependenciesFor(task)
      .filter(isGanttFsDependency)
      .map((dependency) => dependency.predecessorTaskId)
      .filter((predecessorTaskId) => taskById.has(predecessorTaskId) && predecessorTaskId !== task.id)
      .forEach((predecessorTaskId) => {
        outgoing.get(predecessorTaskId)?.add(task.id);
        incoming.get(task.id)?.add(predecessorTaskId);
      });
  });

  const chainTaskIds = new Set<string>();
  tasks.forEach((task) => {
    if ((incoming.get(task.id)?.size ?? 0) > 0 || (outgoing.get(task.id)?.size ?? 0) > 0) {
      chainTaskIds.add(task.id);
    }
  });

  // A dependency chain gets a stable priority over an unrelated task that
  // happens to have an earlier persisted date. The score only breaks ties
  // between independent chains; it does not replace topological ordering.
  const dependencyChainScore = (taskId: string) => (
    (incoming.get(taskId)?.size ?? 0) + (outgoing.get(taskId)?.size ?? 0)
  );
  const compareReady = (left: ResourceCpmTask, right: ResourceCpmTask) => (
    Number(chainTaskIds.has(right.id)) - Number(chainTaskIds.has(left.id))
    || dependencyChainScore(right.id) - dependencyChainScore(left.id)
    || taskOrder(left, right)
  );

  const remainingInDegree = new Map(
    tasks.map((task) => [task.id, incoming.get(task.id)?.size ?? 0] as const),
  );
  const ready = tasks.filter((task) => remainingInDegree.get(task.id) === 0).sort(compareReady);
  const ordered: ResourceCpmTask[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    ordered.push(current);
    (outgoing.get(current.id) ?? new Set()).forEach((successorId) => {
      const nextDegree = (remainingInDegree.get(successorId) ?? 0) - 1;
      remainingInDegree.set(successorId, nextDegree);
      if (nextDegree === 0) {
        const successor = taskById.get(successorId);
        if (!successor) return;
        ready.push(successor);
        ready.sort(compareReady);
      }
    });
  }

  // Keep malformed/cyclic input deterministic. The explicit dependency issue
  // is reported by the scheduling engine; resource links must not add another
  // cycle while the user is repairing that graph.
  if (ordered.length < tasks.length) {
    const orderedIds = new Set(ordered.map((task) => task.id));
    ordered.push(...tasks.filter((task) => !orderedIds.has(task.id)).sort(taskOrder));
  }

  return new Map(ordered.map((task, index) => [task.id, index] as const));
};

const graphHasPath = (
  outgoing: Map<string, Set<string>>,
  fromId: string,
  targetId: string,
) => {
  if (fromId === targetId) return true;
  const visited = new Set<string>();
  const pending = [fromId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const successorId of outgoing.get(current) ?? []) {
      if (successorId === targetId) return true;
      pending.push(successorId);
    }
  }
  return false;
};

/**
 * Builds the serial capacity edges that are implied by the persisted bars.
 *
 * A single person cannot execute two active leaf tasks at the same time, so
 * adjacent tasks assigned to that person form a derived FS chain. This chain
 * is used only by CPM for float/criticality; the user's dependency graph is
 * left untouched. Completed work is excluded because it no longer consumes
 * current capacity.
 */
export const buildResourceSerialLinks = (tasks: ResourceCpmTask[]): ResourceCpmLink[] => {
  const parentIds = new Set(tasks.flatMap((task) => task.parentId ? [task.parentId] : []));
  const activeLeaves = tasks.filter((task) => (
    taskIsLeaf(task, parentIds)
    && Number(task.progress ?? 0) < 100
    && dateRangeIsValid(task)
    && ownerKeysFor(task).length > 0
  ));
  const byOwner = new Map<string, ResourceCpmTask[]>();
  activeLeaves.forEach((task) => {
    ownerKeysFor(task).forEach((ownerKey) => {
      byOwner.set(ownerKey, [...(byOwner.get(ownerKey) ?? []), task]);
    });
  });

  const dependencyOrder = dependencyFirstOrder(activeLeaves);
  const explicitOutgoing = new Map<string, Set<string>>(
    activeLeaves.map((task) => [task.id, new Set<string>()] as const),
  );
  activeLeaves.forEach((task) => {
    dependenciesFor(task)
      .filter(isGanttFsDependency)
      .map((dependency) => dependency.predecessorTaskId)
      .filter((predecessorTaskId) => explicitOutgoing.has(predecessorTaskId) && predecessorTaskId !== task.id)
      .forEach((predecessorTaskId) => explicitOutgoing.get(predecessorTaskId)?.add(task.id));
  });

  const links = new Map<string, ResourceCpmLink>();
  byOwner.forEach((ownerTasks, ownerKey) => {
    const ordered = [...new Map(ownerTasks.map((task) => [task.id, task] as const)).values()]
      .sort((left, right) => (
        (dependencyOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
          - (dependencyOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
        || taskOrder(left, right)
      ));
    for (let index = 1; index < ordered.length; index += 1) {
      const predecessor = ordered[index - 1];
      const successor = ordered[index];
      if (predecessor.id === successor.id) continue;
      // The dependency-first order already avoids normal reverse edges. Keep
      // this guard for malformed/cyclic input so resource leveling never makes
      // an existing dependency cycle worse.
      if (graphHasPath(explicitOutgoing, successor.id, predecessor.id)) continue;
      const key = dependencyKey(predecessor.id, successor.id);
      links.set(`${key}:${ownerKey}`, { predecessorTaskId: predecessor.id, successorTaskId: successor.id, ownerKey });
      explicitOutgoing.get(predecessor.id)?.add(successor.id);
    }
  });

  return [...links.values()].sort((left, right) => (
    left.predecessorTaskId.localeCompare(right.predecessorTaskId)
    || left.successorTaskId.localeCompare(right.successorTaskId)
    || left.ownerKey.localeCompare(right.ownerKey)
  ));
};

/**
 * Runs the normal CPM after adding derived same-owner FS edges. This makes
 * resource waiting part of both total/free float and critical-path results.
 */
export const calculateResourceAwareGanttCpm = (
  tasks: ResourceCpmTask[],
  mode: Parameters<typeof calculateGanttCpm>[1],
  requiredFinishDate = "",
): ResourceAwareGanttCpmResult => {
  // Relative T0 schedules have no real calendar date. Use the same abstract
  // working-day anchor as the scheduler so resource ordering is still applied
  // before a concrete T0 is entered. Relative coordinates take precedence
  // over stale imported absolute dates.
  const normalizedTasks = materializeRelativeResourceDates(tasks);
  const hasRelativeCoordinates = normalizedTasks.some((task) => (
    isGanttRelativeOffset(task.relativeStartOffsetDays)
    || isGanttRelativeOffset(task.relativeFinishOffsetDays)
  ));
  const effectiveMode = hasRelativeCoordinates ? "CALENDAR_DAYS" : mode;
  const resourceLinks = buildResourceSerialLinks(normalizedTasks);
  const dependenciesBySuccessor = new Map<string, CpmGanttDependency[]>();
  resourceLinks.forEach((link) => {
    dependenciesBySuccessor.set(link.successorTaskId, [
      ...(dependenciesBySuccessor.get(link.successorTaskId) ?? []),
      { predecessorTaskId: link.predecessorTaskId, type: 1, lag: 0, lagFormat: 7 },
    ]);
  });
  const tasksWithResourceDependencies = normalizedTasks.map((task) => {
    const existing = dependenciesFor(task);
    const existingKeys = new Set(existing.map((dependency) => dependencyKey(dependency.predecessorTaskId, task.id)));
    const derived = (dependenciesBySuccessor.get(task.id) ?? [])
      .filter((dependency) => !existingKeys.has(dependencyKey(dependency.predecessorTaskId, task.id)));
    // CPM consumes dependency objects, while list payloads may only expose
    // predecessorTaskIds. Always materialize the normalized dependency list,
    // including when it contains only the user's explicit id references.
    return existing.length > 0 || derived.length > 0
      ? { ...task, predecessorDependencies: [...existing, ...derived] }
      : task;
  });
  const constrained = calculateGanttCpm(
    tasksWithResourceDependencies,
    effectiveMode,
    hasRelativeCoordinates ? "" : requiredFinishDate,
  );

  // A locked summary boundary can make a valid resource chain impossible to
  // fit. In that case the constrained backward pass correctly reports
  // negative float, but its strict zero-float filter would hide the very
  // longest chain the user needs to repair. Re-run only the criticality pass
  // without summary boundary caps; keep the constrained metrics and negative
  // float for the actual conflict display.
  const unconstrainedCriticality = calculateGanttCpm(
    tasksWithResourceDependencies.map((task) => ({
      ...task,
      // AUTO and duration-based tasks are movable during formal scheduling.
      // Their persisted dates describe the current placement, not a CPM
      // constraint. Keeping those dates as fixed anchors creates artificial
      // gaps in a resource chain (for example 1.4.3 -> 1.2.1) and reports
      // false float for the predecessor. Date-fixed tasks remain fixed.
      taskMode: normalizeGanttScheduleMode(task.taskMode) === "DATES_FIXED"
        ? task.taskMode
        : "AUTO",
      parentBoundaryMode: String(task.parentBoundaryMode ?? "").toUpperCase() === "LOCKED"
        ? "ROLLUP"
        : task.parentBoundaryMode,
    })),
    effectiveMode,
    "",
  );
  const criticalTaskIds = new Set(
    resourceLinks.length > 0
      ? [
        ...constrained.projectCriticalTaskIds,
        ...unconstrainedCriticality.projectCriticalTaskIds,
      ]
      : constrained.projectCriticalTaskIds,
  );
  const metricsByTaskId = new Map(constrained.metricsByTaskId);
  criticalTaskIds.forEach((taskId) => {
    const metrics = metricsByTaskId.get(taskId);
    const structuralMetrics = unconstrainedCriticality.metricsByTaskId.get(taskId);
    const task = normalizedTasks.find((candidate) => candidate.id === taskId);
    if (!metrics || Number(task?.progress ?? 0) >= 100) return;
    // A positive constrained float can only be a placement gap for a movable
    // task. The resource-aware longest path has no slack there, so expose zero
    // float to the user. Preserve negative float from locked boundaries: that
    // is a real conflict and must remain visible instead of being normalized.
    const normalizedFloat = metrics.totalFloatMinutes != null
      && metrics.totalFloatMinutes > 0
      && structuralMetrics?.totalFloatMinutes === 0
      ? 0
      : metrics.totalFloatMinutes;
    const normalizedFreeFloat = metrics.freeFloatMinutes != null
      && normalizedFloat === 0
      ? 0
      : metrics.freeFloatMinutes;
    metricsByTaskId.set(taskId, {
      ...metrics,
      totalFloatMinutes: normalizedFloat,
      freeFloatMinutes: normalizedFreeFloat,
      scheduleStatus: normalizedFloat === 0 ? "CRITICAL" : metrics.scheduleStatus,
      isCritical: true,
    });
  });

  return {
    ...constrained,
    metricsByTaskId,
    projectCriticalTaskIds: criticalTaskIds,
    resourceLinks,
  };
};
