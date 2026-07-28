import type { EarnedValueSummary } from "@/lib/earned-value";

export const ASSISTANT_SCHEDULE_SCHEMA_VERSION = 1 as const;

export type AssistantScheduleSchemaVersion = typeof ASSISTANT_SCHEDULE_SCHEMA_VERSION;

export interface AssistantScheduleDependencyV1 {
  id: string;
  createdAt: string;
  updatedAt: string;
  projectId: string;
  predecessorTaskId: string;
  successorTaskId: string;
  predecessorTaskCode: string;
  predecessorTaskName: string;
  successorTaskCode: string;
  successorTaskName: string;
  type: number;
  typeLabel: "FF" | "FS" | "SF" | "SS" | "UNKNOWN";
  lag: number;
  lagFormat: number;
}

export interface AssistantScheduleTaskEarnedValueV1 {
  plannedProgress: number;
  pv: number;
  ev: number;
  sv: number;
  cv: number;
}

export interface AssistantScheduleTaskV1 {
  id: string;
  createdAt: string;
  updatedAt: string;
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
  baselines: unknown[];
  sortOrder: number;
  predecessorDependencies: AssistantScheduleDependencyV1[];
  successorDependencies: AssistantScheduleDependencyV1[];
  earnedValue: AssistantScheduleTaskEarnedValueV1;
}

export interface AssistantScheduleResourceV1 {
  uid: string;
  name: string;
  type: string;
  group: string;
  email: string;
  calendarUid: string;
  maxUnits: number | null;
}

export interface AssistantScheduleAssignmentV1 {
  uid: string;
  taskUid: string;
  taskId: string | null;
  resourceUid: string;
  resourceName: string;
  units: number | null;
  startDate: string;
  finishDate: string;
  workMinutes: number | null;
  actualWorkMinutes: number | null;
  remainingWorkMinutes: number | null;
}

export interface AssistantScheduleContextV1 {
  schemaVersion: AssistantScheduleSchemaVersion;
  projectId: string;
  statusDate: string;
  source: {
    kind: "DATABASE";
    importedFileName: string;
    metadataUpdatedAt: string | null;
  };
  tasks: AssistantScheduleTaskV1[];
  dependencies: AssistantScheduleDependencyV1[];
  resources: AssistantScheduleResourceV1[];
  assignments: AssistantScheduleAssignmentV1[];
  criticalPath: {
    status: "CALCULATED" | "INVALID_DEPENDENCY_GRAPH";
    criticalTaskIds: string[];
  };
  earnedValue: {
    statusDate: string;
    summary: EarnedValueSummary;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);

const hasStrings = (value: Record<string, unknown>, keys: string[]) => (
  keys.every((key) => typeof value[key] === "string")
);

const hasFiniteNumbers = (value: Record<string, unknown>, keys: string[]) => (
  keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]))
);

const isNullableFiniteNumber = (value: unknown) => value === null
  || (typeof value === "number" && Number.isFinite(value));

const isDependency = (value: unknown) => {
  if (!isRecord(value)) return false;
  return hasStrings(value, [
    "id", "createdAt", "updatedAt", "projectId", "predecessorTaskId", "successorTaskId",
    "predecessorTaskCode", "predecessorTaskName", "successorTaskCode", "successorTaskName", "typeLabel",
  ]) && hasFiniteNumbers(value, ["type", "lag", "lagFormat"]);
};

const isTaskEarnedValue = (value: unknown) => isRecord(value)
  && hasFiniteNumbers(value, ["plannedProgress", "pv", "ev", "sv", "cv"]);

const isTask = (value: unknown) => {
  if (!isRecord(value)) return false;
  return hasStrings(value, [
    "id", "createdAt", "updatedAt", "projectId", "taskCode", "taskCategory", "taskName", "startDate",
    "finishDate", "actualStartDate", "actualEndDate", "predecessorTask", "taskMode", "externalUid", "wbsCode",
    "outlineNumber", "calendarUid", "constraintDate", "baselineStartDate", "baselineFinishDate",
  ])
    && (value.parentId === null || typeof value.parentId === "string")
    && (value.constraintType === null || (typeof value.constraintType === "number" && Number.isFinite(value.constraintType)))
    && typeof value.isMilestone === "boolean"
    && hasFiniteNumbers(value, [
      "durationDays", "durationMinutes", "durationFormat", "progress", "baselineCost", "budgetAtCompletion",
      "actualCost", "sortOrder",
    ])
    && Array.isArray(value.baselines)
    && Array.isArray(value.predecessorDependencies)
    && value.predecessorDependencies.every(isDependency)
    && Array.isArray(value.successorDependencies)
    && value.successorDependencies.every(isDependency)
    && isTaskEarnedValue(value.earnedValue);
};

const isResource = (value: unknown) => isRecord(value)
  && hasStrings(value, ["uid", "name", "type", "group", "email", "calendarUid"])
  && isNullableFiniteNumber(value.maxUnits);

const isAssignment = (value: unknown) => isRecord(value)
  && hasStrings(value, ["uid", "taskUid", "resourceUid", "resourceName", "startDate", "finishDate"])
  && (value.taskId === null || typeof value.taskId === "string")
  && ["units", "workMinutes", "actualWorkMinutes", "remainingWorkMinutes"]
    .every((key) => isNullableFiniteNumber(value[key]));

const isForecast = (value: unknown) => isRecord(value)
  && ["etc", "eac", "vac", "tcpiEac"].every((key) => isNullableFiniteNumber(value[key]));

const isEarnedValueSummary = (value: unknown) => isRecord(value)
  && hasFiniteNumbers(value, ["pv", "ev", "ac", "sv", "cv", "bac"])
  && ["spi", "cpi", "tcpiBac"].every((key) => isNullableFiniteNumber(value[key]))
  && isForecast(value.typical)
  && isForecast(value.atypical);

export const isAssistantScheduleContextV1 = (value: unknown): value is AssistantScheduleContextV1 => {
  if (!isRecord(value) || value.schemaVersion !== ASSISTANT_SCHEDULE_SCHEMA_VERSION) return false;
  return typeof value.projectId === "string"
    && typeof value.statusDate === "string"
    && Array.isArray(value.tasks)
    && value.tasks.every(isTask)
    && Array.isArray(value.dependencies)
    && value.dependencies.every(isDependency)
    && Array.isArray(value.resources)
    && value.resources.every(isResource)
    && Array.isArray(value.assignments)
    && value.assignments.every(isAssignment)
    && isRecord(value.source)
    && value.source.kind === "DATABASE"
    && typeof value.source.importedFileName === "string"
    && (value.source.metadataUpdatedAt === null || typeof value.source.metadataUpdatedAt === "string")
    && isRecord(value.criticalPath)
    && ["CALCULATED", "INVALID_DEPENDENCY_GRAPH"].includes(String(value.criticalPath.status))
    && Array.isArray(value.criticalPath.criticalTaskIds)
    && value.criticalPath.criticalTaskIds.every((taskId) => typeof taskId === "string")
    && isRecord(value.earnedValue)
    && typeof value.earnedValue.statusDate === "string"
    && isEarnedValueSummary(value.earnedValue.summary);
};

export const assertAssistantScheduleContextV1 = (value: unknown): AssistantScheduleContextV1 => {
  if (!isRecord(value)) throw new Error("助手计划协议格式无效");
  if (value.schemaVersion !== ASSISTANT_SCHEDULE_SCHEMA_VERSION) {
    throw new Error(`不支持的助手计划协议版本：${String(value.schemaVersion ?? "未指定")}`);
  }
  if (!isAssistantScheduleContextV1(value)) throw new Error("助手计划协议缺少必需字段");
  return value;
};
