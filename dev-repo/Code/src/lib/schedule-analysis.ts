import { addCalendarDays, addDaysInclusive, diffDays, findGanttCriticalTaskIds } from "@/lib/gantt";

export const SCHEDULE_SNAPSHOT_SCHEMA_VERSION = "1.0" as const;

export type ScheduleDependency = {
  predecessorTaskId: string;
  type: number;
  lag: number;
  lagFormat: number;
};

export type ScheduleTask = {
  id: string;
  externalUid: string;
  taskCode: string;
  taskName: string;
  taskCategory: string;
  parentId: string | null;
  wbsCode: string;
  outlineNumber: string;
  startDate: string;
  finishDate: string;
  durationDays: number;
  durationMinutes: number;
  durationFormat: number;
  actualStartDate: string;
  actualEndDate: string;
  progress: number;
  taskMode: string;
  isMilestone: boolean;
  calendarUid: string;
  constraintType: number | null;
  constraintDate: string;
  baselineStartDate: string;
  baselineFinishDate: string;
  baselineCost: number;
  budgetAtCompletion: number;
  actualCost: number;
  baselines: unknown[];
  dependencies: ScheduleDependency[];
};

export type ScheduleSnapshot = {
  schemaVersion: typeof SCHEDULE_SNAPSHOT_SCHEMA_VERSION;
  sourceFileName: string;
  statusDate: string;
  tasks: ScheduleTask[];
  metadata: {
    projectSettings: Record<string, unknown>;
    calendars: Record<string, unknown>;
    resources: Record<string, unknown>;
    assignments: Record<string, unknown>;
    taskUidMap: Record<string, string>;
  } | null;
};

export type ScheduleMatch = {
  incomingTaskId: string;
  currentTaskId: string | null;
  rule: "EXTERNAL_UID" | "TASK_CODE" | "WBS_OUTLINE" | "NAME_PARENT" | "UNMATCHED" | "AMBIGUOUS";
  confidence: number;
};

export type ScheduleFieldChange = {
  taskId: string;
  taskCode: string;
  taskName: string;
  field: string;
  before: unknown;
  after: unknown;
};

export type ScheduleIssue = {
  ruleId: string;
  severity: "INFO" | "WARNING" | "ERROR";
  taskIds: string[];
  taskCodes: string[];
  message: string;
  facts: Record<string, unknown>;
  expected?: Record<string, unknown>;
  impactTaskIds: string[];
  suggestion: string;
};

export type ScheduleAnalysisResult = {
  schemaVersion: typeof SCHEDULE_SNAPSHOT_SCHEMA_VERSION;
  statusDate: string;
  summary: {
    currentTasks: number;
    incomingTasks: number;
    matched: number;
    added: number;
    removedCandidates: number;
    changedFields: number;
    errors: number;
    warnings: number;
  };
  matches: ScheduleMatch[];
  changes: ScheduleFieldChange[];
  addedTaskIds: string[];
  removedCandidateTaskIds: string[];
  criticalTaskIds: string[];
  issues: ScheduleIssue[];
};

const normalized = (value: string) => value.trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, " ");

const taskParentPath = (task: ScheduleTask, tasks: Map<string, ScheduleTask>) => {
  const path: string[] = [];
  const visited = new Set<string>();
  let cursor = task.parentId ? tasks.get(task.parentId) : undefined;
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    path.unshift(normalized(cursor.taskName));
    cursor = cursor.parentId ? tasks.get(cursor.parentId) : undefined;
  }
  return path.join("/");
};

const uniqueIndex = (tasks: ScheduleTask[], key: (task: ScheduleTask) => string) => {
  const index = new Map<string, ScheduleTask[]>();
  for (const task of tasks) {
    const value = key(task);
    if (!value) continue;
    index.set(value, [...(index.get(value) ?? []), task]);
  }
  return index;
};

export const matchScheduleTasks = (current: ScheduleTask[], incoming: ScheduleTask[]): ScheduleMatch[] => {
  const currentById = new Map(current.map((task) => [task.id, task]));
  const incomingById = new Map(incoming.map((task) => [task.id, task]));
  const indexes = [
    { rule: "EXTERNAL_UID" as const, confidence: 1, values: uniqueIndex(current, (task) => normalized(task.externalUid)), incoming: (task: ScheduleTask) => normalized(task.externalUid) },
    { rule: "TASK_CODE" as const, confidence: 0.98, values: uniqueIndex(current, (task) => normalized(task.taskCode)), incoming: (task: ScheduleTask) => normalized(task.taskCode) },
    { rule: "WBS_OUTLINE" as const, confidence: 0.92, values: uniqueIndex(current, (task) => task.wbsCode && task.outlineNumber ? `${normalized(task.wbsCode)}|${normalized(task.outlineNumber)}` : ""), incoming: (task: ScheduleTask) => task.wbsCode && task.outlineNumber ? `${normalized(task.wbsCode)}|${normalized(task.outlineNumber)}` : "" },
    { rule: "NAME_PARENT" as const, confidence: 0.78, values: uniqueIndex(current, (task) => `${normalized(task.taskName)}|${taskParentPath(task, currentById)}`), incoming: (task: ScheduleTask) => `${normalized(task.taskName)}|${taskParentPath(task, incomingById)}` },
  ];
  const usedCurrent = new Set<string>();

  return incoming.map((task) => {
    for (const index of indexes) {
      const key = index.incoming(task);
      if (!key) continue;
      const candidates = (index.values.get(key) ?? []).filter((candidate) => !usedCurrent.has(candidate.id));
      if (candidates.length === 1) {
        usedCurrent.add(candidates[0].id);
        return { incomingTaskId: task.id, currentTaskId: candidates[0].id, rule: index.rule, confidence: index.confidence };
      }
      if (candidates.length > 1) {
        return { incomingTaskId: task.id, currentTaskId: null, rule: "AMBIGUOUS", confidence: 0 };
      }
    }
    return { incomingTaskId: task.id, currentTaskId: null, rule: "UNMATCHED", confidence: 0 };
  });
};

const COMPARABLE_FIELDS: Array<keyof ScheduleTask> = [
  "taskName", "taskCategory", "parentId", "wbsCode", "outlineNumber", "startDate", "finishDate",
  "durationDays", "durationMinutes", "durationFormat", "actualStartDate", "actualEndDate", "progress",
  "taskMode", "isMilestone", "calendarUid", "constraintType", "constraintDate", "baselineStartDate",
  "baselineFinishDate", "baselineCost", "budgetAtCompletion", "actualCost", "baselines", "dependencies",
];

const stableValue = (value: unknown) => {
  if (!Array.isArray(value)) return JSON.stringify(value ?? null);
  return JSON.stringify([...value].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
};

export const diffScheduleTasks = (
  current: ScheduleTask[],
  incoming: ScheduleTask[],
  matches: ScheduleMatch[],
): ScheduleFieldChange[] => {
  const currentById = new Map(current.map((task) => [task.id, task]));
  const incomingById = new Map(incoming.map((task) => [task.id, task]));
  return matches.flatMap((match) => {
    if (!match.currentTaskId) return [];
    const before = currentById.get(match.currentTaskId);
    const after = incomingById.get(match.incomingTaskId);
    if (!before || !after) return [];
    return COMPARABLE_FIELDS.flatMap((field) => stableValue(before[field]) === stableValue(after[field]) ? [] : [{
      taskId: before.id,
      taskCode: before.taskCode,
      taskName: before.taskName,
      field,
      before: before[field],
      after: after[field],
    }]);
  });
};

const dependencyTypeLabel = (type: number) => ({ 0: "FF", 1: "FS", 2: "SF", 3: "SS" })[type] ?? `TYPE_${type}`;

export const lagToDays = (lag: number, lagFormat: number) => {
  if (!Number.isFinite(lag) || lag === 0) return 0;
  if (lagFormat === 3) return lag / (8 * 60);
  if (lagFormat === 5) return lag / 8;
  if (lagFormat === 7) return lag;
  return lag / (8 * 60);
};

const addLag = (date: string, lag: number, lagFormat: number) => (
  addCalendarDays(date, Math.ceil(lagToDays(lag, lagFormat)))
);

const impactChain = (taskId: string, outgoing: Map<string, string[]>) => {
  const result: string[] = [];
  const queue = [...(outgoing.get(taskId) ?? [])];
  const visited = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);
    for (const next of outgoing.get(id) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return result;
};

const scheduleGraph = (tasks: ScheduleTask[]) => {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      outgoing.set(dependency.predecessorTaskId, [...(outgoing.get(dependency.predecessorTaskId) ?? []), task.id]);
      incoming.set(task.id, [...(incoming.get(task.id) ?? []), dependency.predecessorTaskId]);
    }
  }
  return { outgoing, incoming };
};

export const findScheduleCycles = (tasks: ScheduleTask[]) => {
  const { outgoing } = scheduleGraph(tasks);
  const state = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    state.set(id, 1);
    stack.push(id);
    for (const next of outgoing.get(id) ?? []) {
      if ((state.get(next) ?? 0) === 0) visit(next);
      else if (state.get(next) === 1) {
        const start = stack.lastIndexOf(next);
        const cycle = [...stack.slice(start), next];
        const signature = [...new Set(cycle)].sort().join("|");
        if (!seen.has(signature)) {
          seen.add(signature);
          cycles.push(cycle);
        }
      }
    }
    stack.pop();
    state.set(id, 2);
  };
  tasks.forEach((task) => {
    if ((state.get(task.id) ?? 0) === 0) visit(task.id);
  });
  return cycles;
};

const constraintViolation = (task: ScheduleTask) => {
  if (!task.constraintDate || task.constraintType === null) return null;
  const date = task.constraintDate;
  const type = task.constraintType;
  if (type === 2 && task.startDate !== date) return "任务必须在约束日期开始";
  if (type === 3 && task.finishDate !== date) return "任务必须在约束日期完成";
  if (type === 4 && task.startDate < date) return "任务开始早于最早开始约束";
  if (type === 5 && task.startDate > date) return "任务开始晚于最晚开始约束";
  if (type === 6 && task.finishDate < date) return "任务完成早于最早完成约束";
  if (type === 7 && task.finishDate > date) return "任务完成晚于最晚完成约束";
  return null;
};

export const analyzeScheduleIssues = (tasks: ScheduleTask[], statusDate: string): ScheduleIssue[] => {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const { outgoing } = scheduleGraph(tasks);
  const issues: ScheduleIssue[] = [];
  const issue = (value: Omit<ScheduleIssue, "taskCodes" | "impactTaskIds"> & { impactFrom?: string }) => {
    issues.push({
      ...value,
      taskCodes: value.taskIds.map((id) => taskById.get(id)?.taskCode || id),
      impactTaskIds: value.impactFrom ? impactChain(value.impactFrom, outgoing) : [],
    });
  };

  for (const cycle of findScheduleCycles(tasks)) {
    issue({ ruleId: "SCHEDULE_DEPENDENCY_CYCLE", severity: "ERROR", taskIds: [...new Set(cycle)], message: "任务依赖形成循环", facts: { cycle }, suggestion: "删除或调整循环中的至少一条依赖关系" });
  }

  const externalUids = uniqueIndex(tasks, (task) => normalized(task.externalUid));
  const wbsCodes = uniqueIndex(tasks, (task) => normalized(task.wbsCode));
  for (const [value, duplicates] of [...externalUids, ...wbsCodes]) {
    if (duplicates.length < 2) continue;
    issue({ ruleId: "SCHEDULE_DUPLICATE_IDENTIFIER", severity: "ERROR", taskIds: duplicates.map((task) => task.id), message: `存在重复计划标识：${value}`, facts: { value }, suggestion: "在继续合并前修复重复 UID 或 WBS" });
  }

  for (const task of tasks) {
    const finishDate = task.finishDate || (task.startDate ? addDaysInclusive(task.startDate, task.durationDays) : "");
    if (!task.startDate || !finishDate || task.durationDays < 0 || task.progress < 0 || task.progress > 100) {
      issue({ ruleId: "SCHEDULE_INVALID_TASK_DATA", severity: "ERROR", taskIds: [task.id], message: "任务日期、工期或进度数据无效", facts: { startDate: task.startDate, finishDate, durationDays: task.durationDays, progress: task.progress }, suggestion: "补齐日期并将工期、进度调整到有效范围" });
    }
    if (task.parentId && !taskById.has(task.parentId)) {
      issue({ ruleId: "SCHEDULE_ORPHAN_PARENT", severity: "ERROR", taskIds: [task.id], message: "任务引用了不存在的父任务", facts: { parentId: task.parentId }, suggestion: "重新选择父任务或将任务调整为顶层任务" });
    }
    const parent = task.parentId ? taskById.get(task.parentId) : undefined;
    if (parent && (task.startDate < parent.startDate || finishDate > parent.finishDate)) {
      issue({ ruleId: "SCHEDULE_PARENT_DATE_RANGE", severity: "WARNING", taskIds: [parent.id, task.id], message: "子任务日期超出父任务范围", facts: { parentStart: parent.startDate, parentFinish: parent.finishDate, childStart: task.startDate, childFinish: finishDate }, suggestion: "调整父任务汇总日期或子任务计划" });
    }
    const violation = constraintViolation({ ...task, finishDate });
    if (violation) {
      issue({ ruleId: "SCHEDULE_CONSTRAINT_CONFLICT", severity: "ERROR", taskIds: [task.id], message: violation, facts: { constraintType: task.constraintType, constraintDate: task.constraintDate, startDate: task.startDate, finishDate }, suggestion: "调整任务日期或重新确认约束" });
    }
    if (task.baselineFinishDate && finishDate > task.baselineFinishDate) {
      issue({ ruleId: "SCHEDULE_BASELINE_DELAY", severity: task.isMilestone ? "ERROR" : "WARNING", taskIds: [task.id], impactFrom: task.id, message: `${task.isMilestone ? "里程碑" : "任务"}晚于基线完成日期`, facts: { baselineFinishDate: task.baselineFinishDate, finishDate, varianceDays: diffDays(task.baselineFinishDate, finishDate) }, suggestion: "检查后续依赖并制定追回计划" });
    }
    if (finishDate < statusDate && task.progress < 100) {
      issue({ ruleId: "SCHEDULE_PROGRESS_OVERDUE", severity: task.isMilestone ? "ERROR" : "WARNING", taskIds: [task.id], impactFrom: task.id, message: "状态日期下任务已逾期但尚未完成", facts: { statusDate, finishDate, progress: task.progress }, suggestion: "更新实际进度、剩余工期和后续任务安排" });
    }

    for (const dependency of task.dependencies) {
      const predecessor = taskById.get(dependency.predecessorTaskId);
      if (!predecessor) {
        issue({ ruleId: "SCHEDULE_MISSING_PREDECESSOR", severity: "ERROR", taskIds: [task.id], message: "依赖引用了不存在的前置任务", facts: { predecessorTaskId: dependency.predecessorTaskId }, suggestion: "删除失效依赖或恢复前置任务" });
        continue;
      }
      const predecessorFinish = predecessor.finishDate || addDaysInclusive(predecessor.startDate, predecessor.durationDays);
      const successorFinish = finishDate;
      const type = dependencyTypeLabel(dependency.type);
      const expectedDate = type === "SS" || type === "SF"
        ? addLag(predecessor.startDate, dependency.lag, dependency.lagFormat)
        : addLag(predecessorFinish, dependency.lag, dependency.lagFormat);
      const actualDate = type === "FF" || type === "SF" ? successorFinish : task.startDate;
      if (actualDate < expectedDate) {
        issue({ ruleId: "SCHEDULE_DEPENDENCY_CONFLICT", severity: "ERROR", taskIds: [predecessor.id, task.id], impactFrom: task.id, message: `${type} 依赖和时滞条件未满足`, facts: { type, lag: dependency.lag, lagFormat: dependency.lagFormat, actualDate }, expected: { earliestDate: expectedDate }, suggestion: "调整后续任务日期、依赖类型或时滞" });
      }
    }
  }

  return issues;
};

const metadataRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const metadataProperty = (value: Record<string, unknown>, key: string) => Object.entries(value)
  .find(([candidate]) => candidate.toLocaleLowerCase("en-US").split(":").at(-1) === key.toLocaleLowerCase("en-US"))?.[1];

const metadataCollection = (value: unknown, itemKey: string): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.map(metadataRecord).filter((item) => Object.keys(item).length > 0);
  const container = metadataRecord(value);
  const nested = metadataProperty(container, itemKey);
  if (Array.isArray(nested)) return nested.map(metadataRecord).filter((item) => Object.keys(item).length > 0);
  if (nested && typeof nested === "object") return [metadataRecord(nested)];
  return metadataProperty(container, "UID") === undefined ? [] : [container];
};

const metadataText = (value: unknown) => {
  if (value === undefined || value === null) return "";
  const record = metadataRecord(value);
  return Object.keys(record).length > 0 && "#text" in record ? String(record["#text"] ?? "").trim() : String(value).trim();
};

export const analyzeScheduleResourceIssues = (snapshot: ScheduleSnapshot): ScheduleIssue[] => {
  if (!snapshot.metadata) return [];
  const taskById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const taskByExternalUid = new Map(snapshot.tasks.filter((task) => task.externalUid).map((task) => [task.externalUid, task]));
  const resourceUids = new Set(metadataCollection(snapshot.metadata.resources, "Resource")
    .map((resource) => metadataText(metadataProperty(resource, "UID"))).filter(Boolean));
  const assignments = metadataCollection(snapshot.metadata.assignments, "Assignment").map((assignment) => {
    const taskUid = metadataText(metadataProperty(assignment, "TaskUID"));
    const mappedTaskId = snapshot.metadata?.taskUidMap[taskUid] || taskUid;
    const task = taskById.get(mappedTaskId) || taskByExternalUid.get(taskUid);
    return {
      uid: metadataText(metadataProperty(assignment, "UID")),
      task,
      taskUid,
      resourceUid: metadataText(metadataProperty(assignment, "ResourceUID")),
      startDate: metadataText(metadataProperty(assignment, "Start")).slice(0, 10) || task?.startDate || "",
      finishDate: metadataText(metadataProperty(assignment, "Finish")).slice(0, 10) || task?.finishDate || "",
    };
  });
  const issues: ScheduleIssue[] = [];
  const byResource = new Map<string, typeof assignments>();
  assignments.forEach((assignment) => {
    if (!assignment.task) {
      issues.push({ ruleId: "SCHEDULE_INVALID_TASK_ASSIGNMENT", severity: "ERROR", taskIds: [], taskCodes: [], message: "资源分配引用了不存在的任务", facts: { assignmentUid: assignment.uid, taskUid: assignment.taskUid }, impactTaskIds: [], suggestion: "修复任务 UID 映射或删除失效分配" });
    }
    if (assignment.resourceUid && !resourceUids.has(assignment.resourceUid)) {
      issues.push({ ruleId: "SCHEDULE_INVALID_RESOURCE_ASSIGNMENT", severity: "ERROR", taskIds: assignment.task ? [assignment.task.id] : [], taskCodes: assignment.task ? [assignment.task.taskCode] : [], message: "任务分配引用了不存在的资源", facts: { assignmentUid: assignment.uid, resourceUid: assignment.resourceUid }, impactTaskIds: [], suggestion: "恢复资源记录或重新选择任务资源" });
    }
    if (assignment.resourceUid && assignment.task) {
      byResource.set(assignment.resourceUid, [...(byResource.get(assignment.resourceUid) ?? []), assignment]);
    }
  });
  for (const [resourceUid, values] of byResource) {
    const ordered = [...values].sort((left, right) => left.startDate.localeCompare(right.startDate));
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        const left = ordered[leftIndex];
        const right = ordered[rightIndex];
        if (!left.startDate || !left.finishDate || !right.startDate || !right.finishDate) continue;
        if (right.startDate > left.finishDate) break;
        if (left.task?.id === right.task?.id) continue;
        const tasks = [left.task!, right.task!];
        issues.push({
          ruleId: "SCHEDULE_RESOURCE_OVERLAP",
          severity: "WARNING",
          taskIds: tasks.map((task) => task.id),
          taskCodes: tasks.map((task) => task.taskCode),
          message: "同一资源在重叠时间内被分配到多个任务",
          facts: { resourceUid, first: { taskCode: tasks[0].taskCode, startDate: left.startDate, finishDate: left.finishDate }, second: { taskCode: tasks[1].taskCode, startDate: right.startDate, finishDate: right.finishDate } },
          impactTaskIds: [],
          suggestion: "核对资源单位和可用时间，必要时调整排期或增加资源",
        });
      }
    }
  }
  return issues;
};

export const analyzeSchedule = (current: ScheduleSnapshot, incoming: ScheduleSnapshot): ScheduleAnalysisResult => {
  if (current.schemaVersion !== SCHEDULE_SNAPSHOT_SCHEMA_VERSION || incoming.schemaVersion !== SCHEDULE_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("不支持的计划快照版本");
  }
  const matches = matchScheduleTasks(current.tasks, incoming.tasks);
  const changes = diffScheduleTasks(current.tasks, incoming.tasks, matches);
  const matchedCurrentIds = new Set(matches.flatMap((match) => match.currentTaskId ? [match.currentTaskId] : []));
  const addedTaskIds = matches.filter((match) => !match.currentTaskId).map((match) => match.incomingTaskId);
  const removedCandidateTaskIds = current.tasks.filter((task) => !matchedCurrentIds.has(task.id)).map((task) => task.id);
  const issues = [
    ...analyzeScheduleIssues(incoming.tasks, incoming.statusDate),
    ...analyzeScheduleResourceIssues(incoming),
  ];
  const criticalTaskIds = [...findGanttCriticalTaskIds(incoming.tasks.map((task) => ({
    ...task,
    createdAt: "",
    updatedAt: "",
    projectId: "",
    predecessorTask: "",
    predecessorTaskIds: task.dependencies.map((dependency) => dependency.predecessorTaskId),
    sortOrder: 0,
  })) )];
  return {
    schemaVersion: SCHEDULE_SNAPSHOT_SCHEMA_VERSION,
    statusDate: incoming.statusDate,
    summary: {
      currentTasks: current.tasks.length,
      incomingTasks: incoming.tasks.length,
      matched: matches.filter((match) => Boolean(match.currentTaskId)).length,
      added: addedTaskIds.length,
      removedCandidates: removedCandidateTaskIds.length,
      changedFields: changes.length,
      errors: issues.filter((item) => item.severity === "ERROR").length,
      warnings: issues.filter((item) => item.severity === "WARNING").length,
    },
    matches,
    changes,
    addedTaskIds,
    removedCandidateTaskIds,
    criticalTaskIds,
    issues,
  };
};
