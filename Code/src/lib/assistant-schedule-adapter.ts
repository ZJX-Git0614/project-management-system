import {
  ASSISTANT_SCHEDULE_SCHEMA_VERSION,
  type AssistantScheduleAssignmentV1,
  type AssistantScheduleContextV1,
  type AssistantScheduleDependencyV1,
  type AssistantScheduleResourceV1,
  type AssistantScheduleTaskV1,
} from "@/lib/assistant-schedule-contract";
import { calculateEarnedValue } from "@/lib/earned-value";
import { addDaysInclusive, findGanttCriticalTaskIds } from "@/lib/gantt";

type DateLike = Date | string;

export interface AssistantScheduleDependencySource {
  id: string;
  createdAt: DateLike;
  updatedAt: DateLike;
  projectId: string;
  predecessorTaskId: string;
  successorTaskId: string;
  type: number;
  lag: number;
  lagFormat: number;
  predecessorTask?: { id: string; taskCode: string; taskName: string } | null;
}

export interface AssistantScheduleTaskSource {
  id: string;
  createdAt: DateLike;
  updatedAt: DateLike;
  projectId: string;
  parentId: string | null;
  taskCode: string;
  taskCategory: string;
  taskName: string;
  startDate: string;
  finishDate: string;
  durationDays: number;
  durationMinutes: number;
  durationFormat: number;
  actualStartDate: string;
  actualEndDate: string;
  progress: number;
  predecessorTask: string;
  taskMode: string;
  isMilestone: boolean;
  externalUid: string;
  wbsCode: string;
  outlineNumber: string;
  calendarUid: string;
  constraintType: number | null;
  constraintDate: string;
  baselineStartDate: string;
  baselineFinishDate: string;
  baselineCost: number;
  budgetAtCompletion: number;
  actualCost: number;
  baselines: unknown;
  sortOrder: number;
  predecessorDependencies: AssistantScheduleDependencySource[];
}

export interface AssistantScheduleMetadataSource {
  sourceFileName: string;
  updatedAt: DateLike;
  resources: unknown;
  assignments: unknown;
  taskUidMap: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);

const stringValue = (value: unknown) => {
  if (value === undefined || value === null) return "";
  if (isRecord(value) && "#text" in value) return String(value["#text"] ?? "").trim();
  return String(value).trim();
};

const finiteNumber = (value: unknown): number | null => {
  const parsed = Number(stringValue(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const dateOnly = (value: unknown) => stringValue(value).match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";

const isoString = (value: DateLike) => {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};

const property = (record: Record<string, unknown>, ...keys: string[]) => {
  const entries = Object.entries(record);
  for (const key of keys) {
    const matched = entries.find(([candidate]) => (
      candidate.toLowerCase() === key.toLowerCase()
      || candidate.toLowerCase().endsWith(`:${key.toLowerCase()}`)
    ));
    if (matched) return matched[1];
  }
  return undefined;
};

const collection = (value: unknown, itemKey: string): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  const nested = property(value, itemKey);
  if (Array.isArray(nested)) return nested.filter(isRecord);
  if (isRecord(nested)) return [nested];
  return property(value, "UID", "uid") !== undefined ? [value] : [];
};

const durationMinutes = (value: unknown): number | null => {
  const raw = stringValue(value);
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  const match = raw.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return null;
  return Math.round(
    Number(match[1] ?? 0) * 1_440
    + Number(match[2] ?? 0) * 60
    + Number(match[3] ?? 0)
    + Number(match[4] ?? 0) / 60,
  );
};

const dependencyTypeLabel = (type: number): AssistantScheduleDependencyV1["typeLabel"] => (
  ({ 0: "FF", 1: "FS", 2: "SF", 3: "SS" } as const)[type as 0 | 1 | 2 | 3] ?? "UNKNOWN"
);

const normalizeBaselines = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return [value];
  return [];
};

const normalizeTaskUidMap = (value: unknown) => {
  if (!isRecord(value)) return new Map<string, string>();
  return new Map(Object.entries(value).map(([uid, taskId]) => [uid, stringValue(taskId)]));
};

export const normalizeAssistantScheduleResources = (value: unknown): AssistantScheduleResourceV1[] => (
  collection(value, "Resource").map((resource) => ({
    uid: stringValue(property(resource, "UID", "Id")),
    name: stringValue(property(resource, "Name")),
    type: stringValue(property(resource, "Type")),
    group: stringValue(property(resource, "Group")),
    email: stringValue(property(resource, "EmailAddress", "Email")),
    calendarUid: stringValue(property(resource, "CalendarUID", "BaseCalendarUID")),
    maxUnits: finiteNumber(property(resource, "MaxUnits")),
  })).filter((resource) => resource.uid || resource.name)
);

export const normalizeAssistantScheduleAssignments = (params: {
  value: unknown;
  resources: AssistantScheduleResourceV1[];
  taskUidMap: unknown;
  tasks: AssistantScheduleTaskSource[];
}): AssistantScheduleAssignmentV1[] => {
  const taskUidMap = normalizeTaskUidMap(params.taskUidMap);
  const taskIdByExternalUid = new Map(params.tasks
    .filter((task) => task.externalUid)
    .map((task) => [task.externalUid, task.id]));
  const resourceNameByUid = new Map(params.resources.map((resource) => [resource.uid, resource.name]));
  return collection(params.value, "Assignment").map((assignment) => {
    const taskUid = stringValue(property(assignment, "TaskUID"));
    const resourceUid = stringValue(property(assignment, "ResourceUID"));
    return {
      uid: stringValue(property(assignment, "UID", "Id")),
      taskUid,
      taskId: taskUidMap.get(taskUid) || taskIdByExternalUid.get(taskUid) || null,
      resourceUid,
      resourceName: resourceNameByUid.get(resourceUid) ?? "",
      units: finiteNumber(property(assignment, "Units")),
      startDate: dateOnly(property(assignment, "Start")),
      finishDate: dateOnly(property(assignment, "Finish")),
      workMinutes: durationMinutes(property(assignment, "Work")),
      actualWorkMinutes: durationMinutes(property(assignment, "ActualWork")),
      remainingWorkMinutes: durationMinutes(property(assignment, "RemainingWork")),
    };
  }).filter((assignment) => assignment.uid || assignment.taskUid || assignment.resourceUid);
};

export const buildAssistantScheduleContextV1 = (params: {
  projectId: string;
  tasks: AssistantScheduleTaskSource[];
  metadata?: AssistantScheduleMetadataSource | null;
  statusDate?: string;
}): AssistantScheduleContextV1 => {
  const statusDate = /^\d{4}-\d{2}-\d{2}$/.test(params.statusDate ?? "")
    ? params.statusDate!
    : new Date().toISOString().slice(0, 10);
  const taskById = new Map(params.tasks.map((task) => [task.id, task]));
  const dependencies = params.tasks.flatMap((successor) => (
    successor.predecessorDependencies.map((dependency): AssistantScheduleDependencyV1 => {
      const predecessor = dependency.predecessorTask ?? taskById.get(dependency.predecessorTaskId);
      return {
        id: dependency.id,
        createdAt: isoString(dependency.createdAt),
        updatedAt: isoString(dependency.updatedAt),
        projectId: dependency.projectId,
        predecessorTaskId: dependency.predecessorTaskId,
        successorTaskId: dependency.successorTaskId,
        predecessorTaskCode: predecessor?.taskCode ?? "",
        predecessorTaskName: predecessor?.taskName ?? "",
        successorTaskCode: successor.taskCode,
        successorTaskName: successor.taskName,
        type: dependency.type,
        typeLabel: dependencyTypeLabel(dependency.type),
        lag: dependency.lag,
        lagFormat: dependency.lagFormat,
      };
    })
  ));
  const dependenciesByPredecessor = new Map<string, AssistantScheduleDependencyV1[]>();
  const dependenciesBySuccessor = new Map<string, AssistantScheduleDependencyV1[]>();
  dependencies.forEach((dependency) => {
    dependenciesByPredecessor.set(dependency.predecessorTaskId, [
      ...(dependenciesByPredecessor.get(dependency.predecessorTaskId) ?? []),
      dependency,
    ]);
    dependenciesBySuccessor.set(dependency.successorTaskId, [
      ...(dependenciesBySuccessor.get(dependency.successorTaskId) ?? []),
      dependency,
    ]);
  });

  const earnedValue = calculateEarnedValue(params.tasks.map((task) => ({
    id: task.id,
    taskCode: task.taskCode,
    taskName: task.taskName,
    parentId: task.parentId,
    startDate: task.startDate,
    finishDate: task.finishDate || addDaysInclusive(task.startDate, task.durationDays),
    durationDays: task.durationDays,
    progress: task.progress,
    isMilestone: task.isMilestone,
    baselineStartDate: task.baselineStartDate,
    baselineFinishDate: task.baselineFinishDate,
    budgetAtCompletion: task.budgetAtCompletion,
    actualCost: task.actualCost,
  })), statusDate);
  const earnedValueByTaskId = new Map(earnedValue.rows.map((row) => [row.id, row]));

  const tasks: AssistantScheduleTaskV1[] = params.tasks.map((task) => {
    const row = earnedValueByTaskId.get(task.id)!;
    return {
      id: task.id,
      createdAt: isoString(task.createdAt),
      updatedAt: isoString(task.updatedAt),
      projectId: task.projectId,
      parentId: task.parentId,
      taskCode: task.taskCode,
      taskCategory: task.taskCategory,
      taskName: task.taskName,
      startDate: task.startDate,
      finishDate: task.finishDate,
      durationDays: task.durationDays,
      durationMinutes: task.durationMinutes,
      durationFormat: task.durationFormat,
      actualStartDate: task.actualStartDate,
      actualEndDate: task.actualEndDate,
      progress: task.progress,
      predecessorTask: task.predecessorTask,
      taskMode: task.taskMode,
      isMilestone: task.isMilestone,
      externalUid: task.externalUid,
      wbsCode: task.wbsCode,
      outlineNumber: task.outlineNumber,
      calendarUid: task.calendarUid,
      constraintType: task.constraintType,
      constraintDate: task.constraintDate,
      baselineStartDate: task.baselineStartDate,
      baselineFinishDate: task.baselineFinishDate,
      baselineCost: task.baselineCost,
      budgetAtCompletion: task.budgetAtCompletion,
      actualCost: task.actualCost,
      baselines: normalizeBaselines(task.baselines),
      sortOrder: task.sortOrder,
      predecessorDependencies: dependenciesBySuccessor.get(task.id) ?? [],
      successorDependencies: dependenciesByPredecessor.get(task.id) ?? [],
      earnedValue: {
        plannedProgress: row.plannedProgress,
        pv: row.pv,
        ev: row.ev,
        sv: row.sv,
        cv: row.cv,
      },
    };
  });
  const resources = normalizeAssistantScheduleResources(params.metadata?.resources);
  const assignments = normalizeAssistantScheduleAssignments({
    value: params.metadata?.assignments,
    resources,
    taskUidMap: params.metadata?.taskUidMap,
    tasks: params.tasks,
  });
  const criticalTaskIds = [...findGanttCriticalTaskIds(params.tasks.map((task) => ({
    id: task.id,
    createdAt: isoString(task.createdAt),
    updatedAt: isoString(task.updatedAt),
    projectId: task.projectId,
    parentId: task.parentId,
    taskCode: task.taskCode,
    taskCategory: task.taskCategory,
    taskName: task.taskName,
    startDate: task.startDate,
    finishDate: task.finishDate,
    durationDays: task.durationDays,
    actualStartDate: task.actualStartDate,
    actualEndDate: task.actualEndDate,
    progress: task.progress,
    predecessorTask: task.predecessorTask,
    predecessorTaskIds: task.predecessorDependencies.map((dependency) => dependency.predecessorTaskId),
    sortOrder: task.sortOrder,
  })))];
  const dependencyTaskIds = new Set(dependencies.flatMap((dependency) => [dependency.predecessorTaskId, dependency.successorTaskId]));
  const dependencyGraphInvalid = dependencies.length > 0 && criticalTaskIds.length === 0 && dependencyTaskIds.size > 0;

  return {
    schemaVersion: ASSISTANT_SCHEDULE_SCHEMA_VERSION,
    projectId: params.projectId,
    statusDate,
    source: {
      kind: "DATABASE",
      importedFileName: params.metadata?.sourceFileName ?? "",
      metadataUpdatedAt: params.metadata ? isoString(params.metadata.updatedAt) : null,
    },
    tasks,
    dependencies,
    resources,
    assignments,
    criticalPath: {
      status: dependencyGraphInvalid ? "INVALID_DEPENDENCY_GRAPH" : "CALCULATED",
      criticalTaskIds,
    },
    earnedValue: {
      statusDate: earnedValue.statusDate,
      summary: earnedValue.summary,
    },
  };
};
