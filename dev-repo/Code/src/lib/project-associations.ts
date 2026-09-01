import type { Prisma } from "@prisma/client";

import { itemStatusFromProgress } from "@/lib/item-progress";

export const WEEKLY_ITEM_RELATION_INCLUDE = {
  project: { select: { id: true, name: true, code: true, status: true } },
  ganttTask: {
    select: { id: true, taskCode: true, taskName: true, parentId: true, sortOrder: true },
  },
  ganttTaskLinks: {
    include: {
      ganttTask: {
        select: { id: true, taskCode: true, taskName: true, parentId: true, sortOrder: true },
      },
    },
  },
  riskItems: {
    orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }],
    select: {
      id: true,
      riskCode: true,
      riskName: true,
      weeklyItemId: true,
      category: true,
      trigger: true,
      probability: true,
      impact: true,
      level: true,
      response: true,
      owner: true,
      status: true,
      targetDate: true,
    },
  },
  riskLinks: {
    include: {
      riskItem: {
        select: {
          id: true,
          riskCode: true,
          riskName: true,
          weeklyItemId: true,
          category: true,
          trigger: true,
          probability: true,
          impact: true,
          level: true,
          response: true,
          owner: true,
          status: true,
          targetDate: true,
        },
      },
    },
  },
} satisfies Prisma.WeeklyItemInclude;

const WEEKLY_ITEM_FOR_RISK_INCLUDE = {
  ganttTask: {
    select: { id: true, taskCode: true, taskName: true, parentId: true, sortOrder: true },
  },
  ganttTaskLinks: {
    include: {
      ganttTask: {
        select: { id: true, taskCode: true, taskName: true, parentId: true, sortOrder: true },
      },
    },
  },
} satisfies Prisma.WeeklyItemInclude;

export const RISK_RELATION_INCLUDE = {
  weeklyItem: {
    include: WEEKLY_ITEM_FOR_RISK_INCLUDE,
  },
  weeklyItemLinks: {
    include: {
      weeklyItem: {
        include: WEEKLY_ITEM_FOR_RISK_INCLUDE,
      },
    },
  },
} satisfies Prisma.RiskRegisterItemInclude;

export type WeeklyItemWithRelations = Prisma.WeeklyItemGetPayload<{
  include: typeof WEEKLY_ITEM_RELATION_INCLUDE;
}>;

export type RiskWithRelations = Prisma.RiskRegisterItemGetPayload<{
  include: typeof RISK_RELATION_INCLUDE;
}>;

type ProjectTaskLink = {
  id: string;
  taskCode: string;
  taskName: string;
  parentId: string | null;
  sortOrder: number;
};

type ProjectMatterLink = {
  id: string;
  matterCode: string;
  title: string;
  sortOrder: number;
  ganttTaskId: string | null;
  ganttTask: ProjectTaskLink | null;
  ganttTaskLinks: Array<{ ganttTask: ProjectTaskLink }>;
};

const uniqueStringIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean))];
};

export const relationIdsFromBody = (
  body: Record<string, unknown>,
  pluralKey: string,
  legacyKey: string,
): string[] | undefined => {
  if (Object.prototype.hasOwnProperty.call(body, pluralKey)) {
    return uniqueStringIds(body[pluralKey]);
  }
  if (Object.prototype.hasOwnProperty.call(body, legacyKey)) {
    const value = typeof body[legacyKey] === "string" ? body[legacyKey].trim() : "";
    return value ? [value] : [];
  }
  return undefined;
};

export const findProjectTasks = async (
  tx: Prisma.TransactionClient,
  projectId: string,
  taskIds: string[],
): Promise<ProjectTaskLink[]> => {
  if (taskIds.length === 0) return [];
  const tasks = await tx.projectGanttTask.findMany({
    where: { projectId, id: { in: taskIds } },
    select: { id: true, taskCode: true, taskName: true, parentId: true, sortOrder: true },
  });
  if (tasks.length !== taskIds.length) throw new Error("关联任务不存在或不属于当前项目");
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  return taskIds.map((id) => taskById.get(id)!);
};

export const findProjectMatters = async (
  tx: Prisma.TransactionClient,
  projectId: string,
  weeklyItemIds: string[],
): Promise<ProjectMatterLink[]> => {
  if (weeklyItemIds.length === 0) return [];
  const items = await tx.weeklyItem.findMany({
    where: { projectId, id: { in: weeklyItemIds } },
    select: {
      id: true,
      matterCode: true,
      title: true,
      sortOrder: true,
      ganttTaskId: true,
      ganttTask: {
        select: { id: true, taskCode: true, taskName: true, parentId: true, sortOrder: true },
      },
      ganttTaskLinks: {
        include: {
          ganttTask: {
            select: { id: true, taskCode: true, taskName: true, parentId: true, sortOrder: true },
          },
        },
      },
    },
  });
  if (items.length !== weeklyItemIds.length) throw new Error("关联事项不存在或不属于当前项目");
  const itemById = new Map(items.map((item) => [item.id, item]));
  return weeklyItemIds.map((id) => itemById.get(id)!);
};

export const replaceWeeklyItemTaskLinks = async (
  tx: Prisma.TransactionClient,
  weeklyItemId: string,
  tasks: ProjectTaskLink[],
) => {
  await tx.weeklyItemGanttTask.deleteMany({ where: { weeklyItemId } });
  if (tasks.length > 0) {
    await tx.weeklyItemGanttTask.createMany({
      data: tasks.map((task) => ({ weeklyItemId, ganttTaskId: task.id })),
      skipDuplicates: true,
    });
  }
  const firstTask = tasks[0] ?? null;
  await tx.weeklyItem.update({
    where: { id: weeklyItemId },
    data: {
      ganttTaskId: firstTask?.id ?? null,
      taskName: firstTask?.taskName ?? "",
    },
  });
};

export const replaceRiskMatterLinks = async (
  tx: Prisma.TransactionClient,
  riskItemId: string,
  matters: ProjectMatterLink[],
) => {
  await tx.riskRegisterItemWeeklyItem.deleteMany({ where: { riskItemId } });
  if (matters.length > 0) {
    await tx.riskRegisterItemWeeklyItem.createMany({
      data: matters.map((item) => ({ riskItemId, weeklyItemId: item.id })),
      skipDuplicates: true,
    });
  }
  await tx.riskRegisterItem.update({
    where: { id: riskItemId },
    data: {
      weeklyItemId: matters[0]?.id ?? null,
      ganttTaskId: null,
      linkedItemName: "",
    },
  });
};

const linkedTasksForMatter = (item: ProjectMatterLink): ProjectTaskLink[] => {
  const linked = item.ganttTaskLinks.map((link) => link.ganttTask);
  if (linked.length > 0) return linked;
  return item.ganttTask ? [item.ganttTask] : [];
};

export const serializeWeeklyItem = (item: WeeklyItemWithRelations) => {
  const linkedTasks = item.ganttTaskLinks.length > 0
    ? item.ganttTaskLinks.map((link) => link.ganttTask)
    : item.ganttTask ? [item.ganttTask] : [];
  linkedTasks.sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));

  const linkedRisks = item.riskLinks.length > 0
    ? item.riskLinks.map((link) => link.riskItem)
    : item.riskItems;
  const { ganttTask, ganttTaskLinks, riskItems, riskLinks, ...record } = item;
  void ganttTask;
  void ganttTaskLinks;
  void riskItems;
  void riskLinks;
  return {
    ...record,
    status: itemStatusFromProgress(item.progress),
    ganttTaskId: linkedTasks[0]?.id ?? null,
    ganttTaskIds: linkedTasks.map((task) => task.id),
    taskName: linkedTasks.map((task) => task.taskName).join("、"),
    linkedTasks,
    linkedRisks: linkedRisks.map((risk) => ({
      ...risk,
      linkedItemCode: item.matterCode,
      linkedItemName: item.title,
    })),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
};

export const serializeRisk = (item: RiskWithRelations) => {
  const linkedItems: ProjectMatterLink[] = item.weeklyItemLinks.length > 0
    ? item.weeklyItemLinks.map((link) => link.weeklyItem)
    : item.weeklyItem ? [item.weeklyItem] : [];
  linkedItems.sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));

  const affectedTaskById = new Map<string, ProjectTaskLink>();
  linkedItems.forEach((linkedItem) => {
    linkedTasksForMatter(linkedItem).forEach((task) => affectedTaskById.set(task.id, task));
  });
  const affectedTasks = [...affectedTaskById.values()]
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  const { weeklyItem, weeklyItemLinks, ...record } = item;
  void weeklyItem;
  void weeklyItemLinks;
  return {
    ...record,
    ganttTaskId: null,
    weeklyItemId: linkedItems[0]?.id ?? null,
    weeklyItemIds: linkedItems.map((linkedItem) => linkedItem.id),
    linkedItemCode: linkedItems.map((linkedItem) => linkedItem.matterCode).join("、"),
    linkedItemName: linkedItems.map((linkedItem) => linkedItem.title).join("、"),
    linkedItems: linkedItems.map((linkedItem) => ({
      id: linkedItem.id,
      matterCode: linkedItem.matterCode,
      title: linkedItem.title,
      sortOrder: linkedItem.sortOrder,
    })),
    affectedTasks,
  };
};
