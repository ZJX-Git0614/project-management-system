import type { Prisma } from "@prisma/client";

import {
  buildGanttOwnerIdentityIndex,
  buildGanttOwnerRollups,
  getGanttDescendantIds,
  getEffectiveGanttOwnerMemberId,
  planGanttLegacyOwnerBackfill,
  planGanttOwnerChange,
  planGanttOwnerHierarchyNormalization,
} from "@/lib/gantt-owner-hierarchy";
import { planGanttOwnerMemberReplacement } from "@/lib/gantt-owner-replacement";

export class GanttOwnerReadOnlyError extends Error {
  constructor() {
    super("当前父任务的负责人由后代任务自动汇总，已转为只读；请调整子任务或使用分支批量改派")
    this.name = "GanttOwnerReadOnlyError";
  }
}

const sameOwnerIds = (left: string[] = [], right: string[] = []) => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((id, index) => id === sortedRight[index]);
};

type GanttOwnerWriteContext = {
  tasks: Array<{ id: string; parentId: string | null; ownerMemberId: string | null; ownerMemberIds: string[] }>;
  members: Array<{ id: string; accountId: string | null; personName: string }>;
};

type GanttOwnerUpdate = {
  id: string;
  ownerMemberId: string | null;
  ownerMemberIds?: string[];
};

const getGanttOwnerWriteContext = async (
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<GanttOwnerWriteContext> => {
  const [tasks, members] = await Promise.all([
    tx.projectGanttTask.findMany({
      where: { projectId },
      select: {
        id: true,
        parentId: true,
        ownerMemberId: true,
        ownerLinks: { orderBy: { createdAt: "asc" }, select: { projectMemberId: true } },
      },
    }),
    tx.projectMember.findMany({
      where: { projectId },
      select: { id: true, accountId: true, personName: true },
    }),
  ]);
  return {
    tasks: tasks.map((task) => ({
      id: task.id,
      parentId: task.parentId,
      ownerMemberId: task.ownerMemberId,
      ownerMemberIds: (task.ownerLinks ?? []).length > 0
        ? (task.ownerLinks ?? []).map((link) => link.projectMemberId)
        : task.ownerMemberId ? [task.ownerMemberId] : [],
    })),
    members,
  };
};

const applyOwnerUpdates = async (
  tx: Prisma.TransactionClient,
  updates: GanttOwnerUpdate[],
) => {
  for (const update of updates) {
    const ownerMemberIds = [...new Set(
      update.ownerMemberIds ?? (update.ownerMemberId ? [update.ownerMemberId] : []),
    )];
    await tx.projectGanttTask.update({
      where: { id: update.id },
      data: {
        ownerMemberId: ownerMemberIds.length === 1 ? ownerMemberIds[0] : null,
        resourceNotBeforeDate: "",
      },
    });
    const ownerLinkClient = (tx as Prisma.TransactionClient & {
      projectGanttTaskOwner?: Prisma.TransactionClient["projectGanttTaskOwner"];
    }).projectGanttTaskOwner;
    if (ownerLinkClient) await ownerLinkClient.deleteMany({ where: { taskId: update.id } });
    if (ownerLinkClient && ownerMemberIds.length > 0) {
      await ownerLinkClient.createMany({
        data: ownerMemberIds.map((projectMemberId) => ({ taskId: update.id, projectMemberId })),
        skipDuplicates: true,
      });
    }
  }
};

const tasksAfterOwnerUpdates = (
  tasks: GanttOwnerWriteContext["tasks"],
  updates: GanttOwnerUpdate[],
) => {
  const ownerAfterByTaskId = new Map(tasks.map((task) => [task.id, task.ownerMemberId]));
  const ownerIdsAfterByTaskId = new Map(tasks.map((task) => [task.id, task.ownerMemberIds]));
  updates.forEach((update) => ownerAfterByTaskId.set(update.id, update.ownerMemberId));
  updates.forEach((update) => ownerIdsAfterByTaskId.set(
    update.id,
    update.ownerMemberIds ?? (update.ownerMemberId ? [update.ownerMemberId] : []),
  ));
  return tasks.map((task) => ({
    ...task,
    ownerMemberId: ownerAfterByTaskId.get(task.id) ?? null,
    ownerMemberIds: ownerIdsAfterByTaskId.get(task.id) ?? [],
  }));
};

const synchronizeLinkedOwnerLabels = async ({
  tx,
  projectId,
  affectedTaskIds,
  ownerIdsByTaskId,
  members,
}: {
  tx: Prisma.TransactionClient;
  projectId: string;
  affectedTaskIds: string[];
  ownerIdsByTaskId: Map<string, string[]>;
  members: GanttOwnerWriteContext["members"];
}) => {
  const ownerById = new Map(members.map((owner) => [owner.id, owner]));
  const ownerLabelForTaskIds = (taskIds: string[]) => {
    const namesByIdentity = new Map<string, string>();
    taskIds.forEach((taskId) => {
      (ownerIdsByTaskId.get(taskId) ?? []).forEach((ownerId) => {
        const owner = ownerById.get(ownerId);
        if (owner) namesByIdentity.set(owner.accountId || owner.personName, owner.personName);
      });
    });
    return Array.from(namesByIdentity.values()).join("、");
  };

  const weeklyItems = await tx.weeklyItem.findMany({
    where: {
      projectId,
      OR: [
        { ganttTaskId: { in: affectedTaskIds } },
        { ganttTaskLinks: { some: { ganttTaskId: { in: affectedTaskIds } } } },
      ],
    },
    select: {
      id: true,
      ganttTaskId: true,
      ganttTaskLinks: { select: { ganttTaskId: true } },
    },
  });
  for (const item of weeklyItems) {
    const taskIds = item.ganttTaskLinks.length > 0
      ? item.ganttTaskLinks.map((link) => link.ganttTaskId)
      : item.ganttTaskId ? [item.ganttTaskId] : [];
    await tx.weeklyItem.update({
      where: { id: item.id },
      data: { owner: ownerLabelForTaskIds(taskIds) },
    });
  }

  const weeklyItemIds = weeklyItems.map((item) => item.id);
  const risks = await tx.riskRegisterItem.findMany({
    where: {
      projectId,
      OR: [
        { ganttTaskId: { in: affectedTaskIds } },
        { weeklyItemId: { in: weeklyItemIds } },
        { weeklyItemLinks: { some: { weeklyItemId: { in: weeklyItemIds } } } },
      ],
    },
    select: {
      id: true,
      ganttTaskId: true,
      weeklyItem: {
        select: {
          id: true,
          ganttTaskId: true,
          ganttTaskLinks: { select: { ganttTaskId: true } },
        },
      },
      weeklyItemLinks: {
        select: {
          weeklyItem: {
            select: {
              id: true,
              ganttTaskId: true,
              ganttTaskLinks: { select: { ganttTaskId: true } },
            },
          },
        },
      },
    },
  });
  for (const risk of risks) {
    const matters = risk.weeklyItemLinks.length > 0
      ? risk.weeklyItemLinks.map((link) => link.weeklyItem)
      : risk.weeklyItem ? [risk.weeklyItem] : [];
    const taskIds = [...new Set(matters.flatMap((item) => (
      item.ganttTaskLinks.length > 0
        ? item.ganttTaskLinks.map((link) => link.ganttTaskId)
        : item.ganttTaskId ? [item.ganttTaskId] : []
    )))];
    if (taskIds.length === 0 && risk.ganttTaskId) taskIds.push(risk.ganttTaskId);
    await tx.riskRegisterItem.update({
      where: { id: risk.id },
      data: { owner: ownerLabelForTaskIds(taskIds) },
    });
  }
};

export const resolveEffectiveGanttOwnerMemberId = async ({
  tx,
  projectId,
  taskId,
}: {
  tx: Prisma.TransactionClient;
  projectId: string;
  taskId: string;
}) => {
  const { tasks, members } = await getGanttOwnerWriteContext(tx, projectId);
  return getEffectiveGanttOwnerMemberId(tasks, taskId, buildGanttOwnerIdentityIndex(members));
};

export const resolveEffectiveGanttOwnerMemberIds = async ({
  tx,
  projectId,
  taskId,
}: {
  tx: Prisma.TransactionClient;
  projectId: string;
  taskId: string;
}) => {
  const { tasks, members } = await getGanttOwnerWriteContext(tx, projectId);
  return buildGanttOwnerRollups(tasks, buildGanttOwnerIdentityIndex(members)).get(taskId) ?? [];
};

export const applyGanttOwnerSet = async ({
  tx,
  projectId,
  taskId,
  nextOwnerMemberIds,
  allowBranchReassignment = false,
}: {
  tx: Prisma.TransactionClient;
  projectId: string;
  taskId: string;
  nextOwnerMemberIds: string[];
  allowBranchReassignment?: boolean;
}) => {
  const { tasks, members } = await getGanttOwnerWriteContext(tx, projectId);
  const memberIds = new Set(members.map((member) => member.id));
  const ownerMemberIds = [...new Set(nextOwnerMemberIds.filter((id) => memberIds.has(id)))];
  if (ownerMemberIds.length !== [...new Set(nextOwnerMemberIds.filter(Boolean))].length) {
    throw new Error("负责人必须来自当前项目组成员");
  }
  const target = tasks.find((task) => task.id === taskId);
  if (!target) return { updatedTaskIds: [], affectedTaskIds: [] };
  const identityIndex = buildGanttOwnerIdentityIndex(members);
  const beforeRollups = buildGanttOwnerRollups(tasks, identityIndex);
  const parentTaskIds = new Set(tasks.map((task) => task.parentId).filter((id): id is string => Boolean(id)));
  const isParent = parentTaskIds.has(taskId);
  if (isParent && (beforeRollups.get(taskId)?.length ?? 0) > 0 && !allowBranchReassignment) {
    throw new GanttOwnerReadOnlyError();
  }
  const targetIds = isParent
    ? [taskId, ...getGanttDescendantIds(tasks, taskId)]
    : [taskId];
  const selectedId = ownerMemberIds.length === 1 ? ownerMemberIds[0] : null;
  const directUpdates: GanttOwnerUpdate[] = targetIds.map((id) => ({
    id,
    ownerMemberId: selectedId,
    ownerMemberIds,
  }));
  await applyOwnerUpdates(tx, directUpdates);
  const directlyUpdated = tasksAfterOwnerUpdates(tasks, directUpdates);
  const normalizationUpdates = planGanttOwnerHierarchyNormalization(directlyUpdated, identityIndex);
  await applyOwnerUpdates(tx, normalizationUpdates);
  const afterTasks = tasksAfterOwnerUpdates(directlyUpdated, normalizationUpdates);
  const afterRollups = buildGanttOwnerRollups(afterTasks, identityIndex);
  const affectedTaskIds = tasks
    .filter((task) => !sameOwnerIds(beforeRollups.get(task.id), afterRollups.get(task.id)))
    .map((task) => task.id);
  if (affectedTaskIds.length > 0) {
    await synchronizeLinkedOwnerLabels({ tx, projectId, affectedTaskIds, ownerIdsByTaskId: afterRollups, members });
  }
  return { updatedTaskIds: [...new Set([...targetIds, ...normalizationUpdates.map((item) => item.id)])], affectedTaskIds };
};

export const synchronizeGanttOwnerHierarchy = async ({
  tx,
  projectId,
}: {
  tx: Prisma.TransactionClient;
  projectId: string;
}) => {
  const { tasks, members } = await getGanttOwnerWriteContext(tx, projectId);
  const ownerIdentityIndex = buildGanttOwnerIdentityIndex(members);
  const backfillUpdates = planGanttLegacyOwnerBackfill(tasks);
  const backfilledTasks = tasksAfterOwnerUpdates(tasks, backfillUpdates);
  const normalizationUpdates = planGanttOwnerHierarchyNormalization(backfilledTasks, ownerIdentityIndex);
  const updates = [...backfillUpdates, ...normalizationUpdates];
  await applyOwnerUpdates(tx, updates);
  const normalizedTasks = tasksAfterOwnerUpdates(tasks, updates);
  await synchronizeLinkedOwnerLabels({
    tx,
    projectId,
    affectedTaskIds: normalizedTasks.map((task) => task.id),
    ownerIdsByTaskId: buildGanttOwnerRollups(normalizedTasks, ownerIdentityIndex),
    members,
  });
  return { updatedTaskIds: updates.map((update) => update.id) };
};

export const applyGanttOwnerChange = async ({
  tx,
  projectId,
  taskId,
  nextOwnerMemberId,
  allowBranchReassignment = false,
}: {
  tx: Prisma.TransactionClient;
  projectId: string;
  taskId: string;
  nextOwnerMemberId: string | null;
  allowBranchReassignment?: boolean;
}) => {
  const { tasks, members } = await getGanttOwnerWriteContext(tx, projectId);
  const ownerIdentityIndex = buildGanttOwnerIdentityIndex(members);
  const target = tasks.find((task) => task.id === taskId);
  if (!target) return { updatedTaskIds: [], affectedTaskIds: [] };

  const parentTaskIds = new Set(tasks.map((task) => task.parentId).filter((id): id is string => Boolean(id)));
  const beforeRollups = buildGanttOwnerRollups(tasks, ownerIdentityIndex);
  if (parentTaskIds.has(taskId) && !allowBranchReassignment) {
    const currentOwnerIds = beforeRollups.get(taskId) ?? [];
    if (currentOwnerIds.length > 0) throw new GanttOwnerReadOnlyError();
  }

  const updates = planGanttOwnerChange(tasks, taskId, nextOwnerMemberId, ownerIdentityIndex);
  await applyOwnerUpdates(tx, updates);

  const afterTasks = tasksAfterOwnerUpdates(tasks, updates);
  const afterRollups = buildGanttOwnerRollups(afterTasks, ownerIdentityIndex);
  const affectedTaskIds = tasks
    .filter((task) => !sameOwnerIds(beforeRollups.get(task.id), afterRollups.get(task.id)))
    .map((task) => task.id);

  if (affectedTaskIds.length > 0) {
    await synchronizeLinkedOwnerLabels({ tx, projectId, affectedTaskIds, ownerIdsByTaskId: afterRollups, members });
  }

  return {
    updatedTaskIds: updates.map((update) => update.id),
    affectedTaskIds,
  };
};

export const replaceGanttOwnerMember = async ({
  tx,
  projectId,
  removedMemberId,
  removedPersonName,
  replacementMemberId,
  replacementPersonName,
}: {
  tx: Prisma.TransactionClient;
  projectId: string;
  removedMemberId: string;
  removedPersonName: string;
  replacementMemberId: string | null;
  replacementPersonName: string | null;
}) => {
  const { tasks, members } = await getGanttOwnerWriteContext(tx, projectId);
  const beforeOwnerIdentityIndex = buildGanttOwnerIdentityIndex(members);
  const survivingOwnerIdentityIndex = buildGanttOwnerIdentityIndex(
    members.filter((member) => member.id !== removedMemberId),
  );
  const beforeRollups = buildGanttOwnerRollups(tasks, beforeOwnerIdentityIndex);
  const directlyOwnedTaskCount = tasks.filter((task) => task.ownerMemberIds.includes(removedMemberId)).length;
  const replacementUpdates = planGanttOwnerMemberReplacement(tasks, removedMemberId, replacementMemberId);
  const replacedTasks = tasksAfterOwnerUpdates(tasks, replacementUpdates);
  const normalizationUpdates = planGanttOwnerHierarchyNormalization(replacedTasks, survivingOwnerIdentityIndex);
  const updatesByTaskId = new Map(replacementUpdates.map((update) => [update.id, update]));
  normalizationUpdates.forEach((update) => updatesByTaskId.set(update.id, update));
  const updates = Array.from(updatesByTaskId.values());
  await applyOwnerUpdates(tx, updates);

  const afterTasks = tasksAfterOwnerUpdates(tasks, updates);
  const afterRollups = buildGanttOwnerRollups(afterTasks, survivingOwnerIdentityIndex);
  const affectedTaskIds = tasks
    .filter((task) => !sameOwnerIds(beforeRollups.get(task.id), afterRollups.get(task.id)))
    .map((task) => task.id);

  await Promise.all([
    tx.weeklyItem.updateMany({
      where: { projectId, owner: removedPersonName },
      data: { owner: replacementPersonName ?? "" },
    }),
    tx.riskRegisterItem.updateMany({
      where: { projectId, owner: removedPersonName },
      data: { owner: replacementPersonName ?? "" },
    }),
  ]);

  if (affectedTaskIds.length > 0) {
    await synchronizeLinkedOwnerLabels({ tx, projectId, affectedTaskIds, ownerIdsByTaskId: afterRollups, members });
  }

  return {
    directlyOwnedTaskCount,
    updatedTaskIds: updates.map((update) => update.id),
    affectedTaskIds,
  };
};
