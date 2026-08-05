import { Prisma } from "@prisma/client";

import { PROJECT_MODULES, type ProjectModule } from "@/lib/module-history";
import { prisma } from "@/lib/prisma";

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_LIMIT = 110;

type StoredRecord = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt?: string;
};

interface WeeklyItemsSnapshot {
  version: 1;
  module: "WEEKLY_ITEMS";
  items: StoredRecord[];
  riskLinks: Array<{ riskId: string; weeklyItemId: string }>;
  taskLinks?: Array<{ weeklyItemId: string; ganttTaskId: string }>;
  riskMatterLinks?: Array<{ riskId: string; weeklyItemId: string }>;
}

interface RiskRegisterSnapshot {
  version: 1;
  module: "RISK_REGISTER";
  risks: StoredRecord[];
  weeklyLinks?: Array<{ riskId: string; weeklyItemId: string }>;
}

interface ProjectBudgetSnapshot {
  version: 1;
  module: "PROJECT_BUDGET";
  categories: StoredRecord[];
  items: StoredRecord[];
  ganttLinks: Array<{ taskId: string; budgetItemId: string }>;
}

type ProjectModuleSnapshot = WeeklyItemsSnapshot | RiskRegisterSnapshot | ProjectBudgetSnapshot;

const isProjectModule = (value: string): value is ProjectModule => (
  PROJECT_MODULES.includes(value as ProjectModule)
);

export const requireProjectModule = (value: unknown): ProjectModule => {
  const projectModule = String(value ?? "").trim();
  if (!isProjectModule(projectModule)) throw new Error("操作历史模块无效");
  return projectModule;
};

const serializeRecords = (records: Array<Record<string, unknown>>): StoredRecord[] => (
  JSON.parse(JSON.stringify(records)) as StoredRecord[]
);

const reviveRecord = (record: StoredRecord, projectId: string): Record<string, unknown> => ({
  ...record,
  projectId,
  createdAt: new Date(record.createdAt),
  ...(record.updatedAt ? { updatedAt: new Date(record.updatedAt) } : {}),
});

const capturePayload = async (projectId: string, projectModule: ProjectModule): Promise<ProjectModuleSnapshot> => {
  if (projectModule === "WEEKLY_ITEMS") {
    const [items, riskLinks, taskLinks, riskMatterLinks] = await Promise.all([
      prisma.weeklyItem.findMany({ where: { projectId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }] }),
      prisma.riskRegisterItem.findMany({
        where: { projectId, weeklyItemId: { not: null } },
        select: { id: true, weeklyItemId: true },
      }),
      prisma.weeklyItemGanttTask.findMany({
        where: { weeklyItem: { projectId } },
        select: { weeklyItemId: true, ganttTaskId: true },
      }),
      prisma.riskRegisterItemWeeklyItem.findMany({
        where: { weeklyItem: { projectId } },
        select: { riskItemId: true, weeklyItemId: true },
      }),
    ]);
    return {
      version: SNAPSHOT_VERSION,
      module: projectModule,
      items: serializeRecords(items as unknown as Array<Record<string, unknown>>),
      riskLinks: riskLinks.flatMap((risk) => risk.weeklyItemId
        ? [{ riskId: risk.id, weeklyItemId: risk.weeklyItemId }]
        : []),
      taskLinks,
      riskMatterLinks: riskMatterLinks.map((link) => ({
        riskId: link.riskItemId,
        weeklyItemId: link.weeklyItemId,
      })),
    };
  }

  if (projectModule === "RISK_REGISTER") {
    const [risks, weeklyLinks] = await Promise.all([
      prisma.riskRegisterItem.findMany({
        where: { projectId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      }),
      prisma.riskRegisterItemWeeklyItem.findMany({
        where: { riskItem: { projectId } },
        select: { riskItemId: true, weeklyItemId: true },
      }),
    ]);
    return {
      version: SNAPSHOT_VERSION,
      module: projectModule,
      risks: serializeRecords(risks as unknown as Array<Record<string, unknown>>),
      weeklyLinks: weeklyLinks.map((link) => ({ riskId: link.riskItemId, weeklyItemId: link.weeklyItemId })),
    };
  }

  const [categories, items, ganttLinks] = await Promise.all([
    prisma.projectBudgetCategory.findMany({ where: { projectId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }] }),
    prisma.projectBudgetItem.findMany({ where: { projectId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }] }),
    prisma.projectGanttTask.findMany({
      where: { projectId, budgetItemId: { not: null } },
      select: { id: true, budgetItemId: true },
    }),
  ]);
  return {
    version: SNAPSHOT_VERSION,
    module: projectModule,
    categories: serializeRecords(categories as unknown as Array<Record<string, unknown>>),
    items: serializeRecords(items as unknown as Array<Record<string, unknown>>),
    ganttLinks: ganttLinks.flatMap((task) => task.budgetItemId
      ? [{ taskId: task.id, budgetItemId: task.budgetItemId }]
      : []),
  };
};

export const captureProjectModuleHistorySnapshot = async (params: {
  projectId: string;
  module: ProjectModule;
  sessionId: string;
  label: string;
  operator: string;
}) => {
  const sessionId = params.sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!sessionId) throw new Error("操作历史会话无效");
  const project = await prisma.project.findUnique({ where: { id: params.projectId }, select: { id: true } });
  if (!project) throw new Error("项目不存在");

  const payload = await capturePayload(params.projectId, params.module);
  const snapshot = await prisma.projectModuleHistorySnapshot.create({
    data: {
      projectId: params.projectId,
      module: params.module,
      sessionId,
      label: params.label.slice(0, 120),
      snapshotJson: JSON.stringify(payload),
      createdBy: params.operator,
    },
    select: { id: true, createdAt: true },
  });

  const stale = await prisma.projectModuleHistorySnapshot.findMany({
    where: { projectId: params.projectId, module: params.module, sessionId },
    orderBy: { createdAt: "desc" },
    skip: SNAPSHOT_LIMIT,
    select: { id: true },
  });
  if (stale.length > 0) {
    await prisma.projectModuleHistorySnapshot.deleteMany({ where: { id: { in: stale.map((item) => item.id) } } });
  }

  return { snapshotId: snapshot.id, createdAt: snapshot.createdAt.toISOString() };
};

const parseSnapshot = (raw: string, expectedModule: ProjectModule): ProjectModuleSnapshot => {
  const value = JSON.parse(raw) as Partial<ProjectModuleSnapshot>;
  if (value.version !== SNAPSHOT_VERSION || value.module !== expectedModule) {
    throw new Error("操作历史快照格式不兼容");
  }
  return value as ProjectModuleSnapshot;
};

const restoreWeeklyItems = async (
  tx: Prisma.TransactionClient,
  projectId: string,
  snapshot: WeeklyItemsSnapshot,
) => {
  const warnings: string[] = [];
  const [currentItems, currentRiskLinks, currentRiskMatterLinks] = await Promise.all([
    tx.weeklyItem.findMany({ where: { projectId }, select: { id: true } }),
    tx.riskRegisterItem.findMany({
      where: { projectId, weeklyItemId: { not: null } },
      select: { id: true, weeklyItemId: true },
    }),
    tx.riskRegisterItemWeeklyItem.findMany({
      where: { weeklyItem: { projectId } },
      select: { riskItemId: true, weeklyItemId: true },
    }),
  ]);
  const currentIds = new Set(currentItems.map((item) => item.id));
  const targetIds = new Set(snapshot.items.map((item) => item.id));
  const addedIds = new Set([...targetIds].filter((id) => !currentIds.has(id)));
  const snapshotTaskLinks = snapshot.taskLinks ?? snapshot.items.flatMap((item) => (
    typeof item.ganttTaskId === "string" && item.ganttTaskId
      ? [{ weeklyItemId: item.id, ganttTaskId: item.ganttTaskId }]
      : []
  ));
  const requestedTaskIds = [...new Set(snapshotTaskLinks.map((link) => link.ganttTaskId))];
  const validTasks = await tx.projectGanttTask.findMany({
    where: { projectId, id: { in: requestedTaskIds } },
    select: { id: true, taskName: true },
  });
  const validTaskById = new Map(validTasks.map((task) => [task.id, task]));
  const validTaskLinks = snapshotTaskLinks.filter((link) => (
    targetIds.has(link.weeklyItemId) && validTaskById.has(link.ganttTaskId)
  ));
  const firstTaskByItemId = new Map<string, { id: string; taskName: string }>();
  validTaskLinks.forEach((link) => {
    const task = validTaskById.get(link.ganttTaskId)!;
    if (!firstTaskByItemId.has(link.weeklyItemId)) firstTaskByItemId.set(link.weeklyItemId, task);
  });
  const targetItems = snapshot.items.map((raw) => {
    const record = reviveRecord(raw, projectId);
    const firstTask = firstTaskByItemId.get(raw.id) ?? null;
    const originalLinkCount = snapshotTaskLinks.filter((link) => link.weeklyItemId === raw.id).length;
    const validLinkCount = validTaskLinks.filter((link) => link.weeklyItemId === raw.id).length;
    if (originalLinkCount > validLinkCount) {
      warnings.push(`事项「${String(record.title || record.id)}」的 ${originalLinkCount - validLinkCount} 个原 WBS 任务已不存在，已跳过该关联`);
    }
    return {
      ...record,
      ganttTaskId: firstTask?.id ?? null,
      taskName: firstTask?.taskName ?? "",
    } as unknown as Prisma.WeeklyItemCreateManyInput;
  });

  await tx.weeklyItem.deleteMany({ where: { projectId } });
  if (targetItems.length > 0) await tx.weeklyItem.createMany({ data: targetItems });
  if (validTaskLinks.length > 0) {
    await tx.weeklyItemGanttTask.createMany({ data: validTaskLinks, skipDuplicates: true });
  }

  const desiredRiskMatterLinks = new Map<string, { riskItemId: string; weeklyItemId: string }>();
  currentRiskMatterLinks.forEach((link) => {
    if (currentIds.has(link.weeklyItemId) && targetIds.has(link.weeklyItemId)) {
      desiredRiskMatterLinks.set(`${link.riskItemId}:${link.weeklyItemId}`, link);
    }
  });
  currentRiskLinks.forEach((link) => {
    if (link.weeklyItemId && currentIds.has(link.weeklyItemId) && targetIds.has(link.weeklyItemId)) {
      desiredRiskMatterLinks.set(`${link.id}:${link.weeklyItemId}`, {
        riskItemId: link.id,
        weeklyItemId: link.weeklyItemId,
      });
    }
  });
  const snapshotRiskMatterLinks = snapshot.riskMatterLinks ?? snapshot.riskLinks;
  snapshotRiskMatterLinks.forEach((link) => {
    if (addedIds.has(link.weeklyItemId)) {
      desiredRiskMatterLinks.set(`${link.riskId}:${link.weeklyItemId}`, {
        riskItemId: link.riskId,
        weeklyItemId: link.weeklyItemId,
      });
    }
  });
  const desiredLinks = [...desiredRiskMatterLinks.values()];
  const validRiskIds = new Set((await tx.riskRegisterItem.findMany({
    where: { projectId, id: { in: [...new Set(desiredLinks.map((link) => link.riskItemId))] } },
    select: { id: true },
  })).map((risk) => risk.id));
  const restorableLinks = desiredLinks.filter((link) => validRiskIds.has(link.riskItemId));
  if (restorableLinks.length > 0) {
    await tx.riskRegisterItemWeeklyItem.createMany({ data: restorableLinks, skipDuplicates: true });
  }
  const firstWeeklyItemByRiskId = new Map<string, string>();
  currentRiskLinks.forEach((link) => {
    if (link.weeklyItemId && restorableLinks.some((candidate) => (
      candidate.riskItemId === link.id && candidate.weeklyItemId === link.weeklyItemId
    ))) firstWeeklyItemByRiskId.set(link.id, link.weeklyItemId);
  });
  restorableLinks.forEach((link) => {
    if (!firstWeeklyItemByRiskId.has(link.riskItemId)) firstWeeklyItemByRiskId.set(link.riskItemId, link.weeklyItemId);
  });
  await Promise.all([...firstWeeklyItemByRiskId].map(([riskId, weeklyItemId]) => (
    tx.riskRegisterItem.update({ where: { id: riskId }, data: { weeklyItemId, ganttTaskId: null } })
  )));
  const missedLinks = desiredLinks.length - restorableLinks.length;
  if (missedLinks > 0) warnings.push(`${missedLinks} 条风险关联的风险记录已不存在，未能恢复`);
  return { restoredCount: targetItems.length, warnings };
};

const restoreRiskRegister = async (
  tx: Prisma.TransactionClient,
  projectId: string,
  snapshot: RiskRegisterSnapshot,
) => {
  const warnings: string[] = [];
  const snapshotWeeklyLinks = snapshot.weeklyLinks ?? snapshot.risks.flatMap((risk) => (
    typeof risk.weeklyItemId === "string" && risk.weeklyItemId
      ? [{ riskId: risk.id, weeklyItemId: risk.weeklyItemId }]
      : []
  ));
  const weeklyIds = [...new Set(snapshotWeeklyLinks.map((link) => link.weeklyItemId))];
  const validWeeklyItems = await tx.weeklyItem.findMany({
    where: { projectId, id: { in: weeklyIds } },
    select: { id: true },
  });
  const validWeeklyIds = new Set(validWeeklyItems.map((item) => item.id));
  const riskIds = new Set(snapshot.risks.map((risk) => risk.id));
  const validWeeklyLinks = snapshotWeeklyLinks.filter((link) => (
    riskIds.has(link.riskId) && validWeeklyIds.has(link.weeklyItemId)
  ));
  const firstWeeklyItemByRiskId = new Map<string, string>();
  validWeeklyLinks.forEach((link) => {
    if (!firstWeeklyItemByRiskId.has(link.riskId)) firstWeeklyItemByRiskId.set(link.riskId, link.weeklyItemId);
  });
  const risks = snapshot.risks.map((raw) => {
    const record = reviveRecord(raw, projectId);
    const originalLinkCount = snapshotWeeklyLinks.filter((link) => link.riskId === raw.id).length;
    const validLinkCount = validWeeklyLinks.filter((link) => link.riskId === raw.id).length;
    if (originalLinkCount > validLinkCount) {
      warnings.push(`风险「${String(record.riskName || record.id)}」的 ${originalLinkCount - validLinkCount} 个原事项已不存在，已跳过该关联`);
    }
    if (record.ganttTaskId) warnings.push(`风险「${String(record.riskName || record.id)}」的旧版直接 WBS 关联已移除，影响任务将由关联事项推导`);
    return {
      ...record,
      weeklyItemId: firstWeeklyItemByRiskId.get(raw.id) ?? null,
      ganttTaskId: null,
      linkedItemName: "",
    } as unknown as Prisma.RiskRegisterItemCreateManyInput;
  });
  await tx.riskRegisterItem.deleteMany({ where: { projectId } });
  if (risks.length > 0) await tx.riskRegisterItem.createMany({ data: risks });
  if (validWeeklyLinks.length > 0) {
    await tx.riskRegisterItemWeeklyItem.createMany({
      data: validWeeklyLinks.map((link) => ({ riskItemId: link.riskId, weeklyItemId: link.weeklyItemId })),
      skipDuplicates: true,
    });
  }
  return { restoredCount: risks.length, warnings };
};

const restoreProjectBudget = async (
  tx: Prisma.TransactionClient,
  projectId: string,
  snapshot: ProjectBudgetSnapshot,
) => {
  const warnings: string[] = [];
  const [currentItems, currentGanttLinks] = await Promise.all([
    tx.projectBudgetItem.findMany({ where: { projectId }, select: { id: true } }),
    tx.projectGanttTask.findMany({
      where: { projectId, budgetItemId: { not: null } },
      select: { id: true, budgetItemId: true },
    }),
  ]);
  const currentIds = new Set(currentItems.map((item) => item.id));
  const targetIds = new Set(snapshot.items.map((item) => item.id));
  const targetCategoryIds = new Set(snapshot.categories.map((category) => category.id));
  const addedIds = new Set([...targetIds].filter((id) => !currentIds.has(id)));
  const categories = snapshot.categories.map((record) => (
    reviveRecord(record, projectId) as unknown as Prisma.ProjectBudgetCategoryCreateManyInput
  ));
  const items = snapshot.items
    .filter((record) => targetCategoryIds.has(String(record.categoryId ?? "")))
    .map((record) => reviveRecord(record, projectId) as unknown as Prisma.ProjectBudgetItemCreateManyInput);

  await tx.projectBudgetCategory.deleteMany({ where: { projectId } });
  if (categories.length > 0) await tx.projectBudgetCategory.createMany({ data: categories });
  if (items.length > 0) await tx.projectBudgetItem.createMany({ data: items });

  const desiredLinks = new Map<string, string>();
  currentGanttLinks.forEach((link) => {
    if (link.budgetItemId && currentIds.has(link.budgetItemId) && targetIds.has(link.budgetItemId)) {
      desiredLinks.set(link.id, link.budgetItemId);
    }
  });
  snapshot.ganttLinks.forEach((link) => {
    if (addedIds.has(link.budgetItemId)) desiredLinks.set(link.taskId, link.budgetItemId);
  });
  const restoredCounts = await Promise.all([...desiredLinks].map(([taskId, budgetItemId]) => (
    tx.projectGanttTask.updateMany({ where: { id: taskId, projectId }, data: { budgetItemId } })
  )));
  const missedLinks = restoredCounts.filter((result) => result.count === 0).length;
  if (missedLinks > 0) warnings.push(`${missedLinks} 条 WBS 关联的任务已不存在，未能恢复`);
  return { restoredCount: items.length, warnings };
};

export const restoreProjectModuleHistorySnapshot = async (params: {
  projectId: string;
  module: ProjectModule;
  snapshotId: string;
  operator: string;
  actionLabel: string;
}) => {
  const stored = await prisma.projectModuleHistorySnapshot.findFirst({
    where: { id: params.snapshotId, projectId: params.projectId, module: params.module },
  });
  if (!stored) throw new Error("操作历史快照不存在或已失效");
  const snapshot = parseSnapshot(stored.snapshotJson, params.module);

  return prisma.$transaction(async (tx) => {
    const result = snapshot.module === "WEEKLY_ITEMS"
      ? await restoreWeeklyItems(tx, params.projectId, snapshot)
      : snapshot.module === "RISK_REGISTER"
        ? await restoreRiskRegister(tx, params.projectId, snapshot)
        : await restoreProjectBudget(tx, params.projectId, snapshot);
    await tx.operationHistory.create({
      data: {
        projectId: params.projectId,
        entityType: params.module,
        entityId: stored.id,
        actionType: "RESTORE",
        operator: params.operator,
        detail: params.actionLabel,
      },
    });
    return { message: params.actionLabel, ...result };
  });
};
