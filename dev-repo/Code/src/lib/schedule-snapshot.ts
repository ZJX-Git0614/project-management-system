import type { Prisma } from "@prisma/client";

import type { GanttImportBundle } from "@/lib/gantt-file-transfer";
import { prisma } from "@/lib/prisma";
import {
  SCHEDULE_SNAPSHOT_SCHEMA_VERSION,
  type ScheduleSnapshot,
  type ScheduleTask,
} from "@/lib/schedule-analysis";

const jsonArray = (value: Prisma.JsonValue | unknown): unknown[] => Array.isArray(value) ? value : [];
const jsonObject = (value: Prisma.JsonValue | unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);
const stringRecord = (value: Prisma.JsonValue | unknown): Record<string, string> => Object.fromEntries(
  Object.entries(jsonObject(value)).map(([key, item]) => [key, String(item ?? "")]),
);

export const getCurrentScheduleSnapshot = async (
  projectId: string,
  statusDate = new Date().toISOString().slice(0, 10),
): Promise<ScheduleSnapshot> => {
  const [tasks, metadata] = await Promise.all([
    prisma.projectGanttTask.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: { predecessorDependencies: { orderBy: { createdAt: "asc" } } },
    }),
    prisma.projectScheduleImportMetadata.findUnique({ where: { projectId } }),
  ]);
  return {
    schemaVersion: SCHEDULE_SNAPSHOT_SCHEMA_VERSION,
    sourceFileName: metadata?.sourceFileName || "当前计划",
    statusDate,
    tasks: tasks.map((task): ScheduleTask => ({
      id: task.id,
      databaseId: task.id,
      externalUid: task.externalUid,
      taskCode: task.taskCode,
      taskName: task.taskName,
      taskCategory: task.taskCategory,
      parentId: task.parentId,
      wbsCode: task.wbsCode,
      outlineNumber: task.outlineNumber,
      startDate: task.startDate,
      finishDate: task.finishDate,
      durationDays: task.durationDays,
      durationMinutes: task.durationMinutes,
      durationFormat: task.durationFormat,
      actualStartDate: task.actualStartDate,
      actualEndDate: task.actualEndDate,
      progress: task.progress,
      taskMode: task.taskMode,
      isMilestone: task.isMilestone,
      calendarUid: task.calendarUid,
      constraintType: task.constraintType,
      constraintDate: task.constraintDate,
      baselineStartDate: task.baselineStartDate,
      baselineFinishDate: task.baselineFinishDate,
      baselineCost: task.baselineCost,
      budgetAtCompletion: task.budgetAtCompletion,
      actualCost: task.actualCost,
      baselines: jsonArray(task.baselines),
      dependencies: task.predecessorDependencies.map((dependency) => ({
        predecessorTaskId: dependency.predecessorTaskId,
        type: dependency.type,
        lag: dependency.lag,
        lagFormat: dependency.lagFormat,
      })),
    })),
    metadata: metadata ? {
      projectSettings: jsonObject(metadata.projectSettings),
      calendars: jsonObject(metadata.calendars),
      resources: jsonObject(metadata.resources),
      assignments: jsonObject(metadata.assignments),
      taskUidMap: stringRecord(metadata.taskUidMap),
    } : null,
  };
};

export const buildImportedScheduleSnapshot = (
  sourceFileName: string,
  bundle: GanttImportBundle,
  statusDate = new Date().toISOString().slice(0, 10),
): ScheduleSnapshot => {
  const databaseIdByExternalId = new Map(bundle.tasks.flatMap((task) => (
    task.databaseId ? [[task.externalId, task.databaseId] as const] : []
  )));
  return ({
  schemaVersion: SCHEDULE_SNAPSHOT_SCHEMA_VERSION,
  sourceFileName,
  statusDate,
  tasks: bundle.tasks.map((task): ScheduleTask => ({
    id: task.externalId,
    databaseId: task.databaseId,
    externalUid: task.externalId,
    taskCode: task.wbsCode || task.outlineNumber || task.externalId,
    taskName: task.taskName,
    taskCategory: task.taskCategory,
    parentId: task.parentDatabaseId || (task.parentExternalId ? databaseIdByExternalId.get(task.parentExternalId) || task.parentExternalId : null),
    wbsCode: task.wbsCode,
    outlineNumber: task.outlineNumber,
    startDate: task.startDate,
    finishDate: task.finishDate,
    durationDays: task.durationDays,
    durationMinutes: task.durationMinutes,
    durationFormat: task.durationFormat,
    actualStartDate: task.actualStartDate,
    actualEndDate: task.actualEndDate,
    progress: task.progress,
    taskMode: task.taskMode,
    isMilestone: task.isMilestone,
    calendarUid: task.calendarUid,
    constraintType: task.constraintType,
    constraintDate: task.constraintDate,
    baselineStartDate: task.baselineStartDate,
    baselineFinishDate: task.baselineFinishDate,
    baselineCost: task.baselineCost,
    budgetAtCompletion: task.budgetAtCompletion,
    actualCost: task.actualCost,
    baselines: task.baselines,
    dependencies: task.predecessorDependencies.map((dependency) => ({
      predecessorTaskId: task.predecessorDatabaseIds?.[task.predecessorDependencies.indexOf(dependency)]
        || databaseIdByExternalId.get(dependency.predecessorExternalId)
        || dependency.predecessorExternalId,
      type: dependency.type,
      lag: dependency.lag,
      lagFormat: dependency.lagFormat,
    })),
  })),
  metadata: bundle.metadata ? {
    ...bundle.metadata,
    taskUidMap: stringRecord(bundle.metadata.taskUidMap),
  } : null,
  });
};
