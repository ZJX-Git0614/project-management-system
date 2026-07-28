import { describe, expect, it } from "vitest";

import {
  analyzeSchedule,
  analyzeScheduleIssues,
  findScheduleCycles,
  matchScheduleTasks,
  SCHEDULE_SNAPSHOT_SCHEMA_VERSION,
  type ScheduleSnapshot,
  type ScheduleTask,
} from "@/lib/schedule-analysis";

const task = (value: Partial<ScheduleTask> & Pick<ScheduleTask, "id" | "taskName">): ScheduleTask => ({
  id: value.id,
  databaseId: value.databaseId,
  externalUid: value.externalUid ?? value.id,
  taskCode: value.taskCode ?? value.id,
  taskName: value.taskName,
  taskCategory: value.taskCategory ?? "",
  parentId: value.parentId ?? null,
  wbsCode: value.wbsCode ?? value.id,
  outlineNumber: value.outlineNumber ?? value.id,
  startDate: value.startDate ?? "2026-07-01",
  finishDate: value.finishDate ?? "2026-07-02",
  durationDays: value.durationDays ?? 2,
  durationMinutes: value.durationMinutes ?? 960,
  durationFormat: value.durationFormat ?? 7,
  actualStartDate: value.actualStartDate ?? "",
  actualEndDate: value.actualEndDate ?? "",
  progress: value.progress ?? 0,
  taskMode: value.taskMode ?? "AUTO",
  isMilestone: value.isMilestone ?? false,
  calendarUid: value.calendarUid ?? "",
  constraintType: value.constraintType ?? null,
  constraintDate: value.constraintDate ?? "",
  baselineStartDate: value.baselineStartDate ?? "",
  baselineFinishDate: value.baselineFinishDate ?? "",
  baselineCost: value.baselineCost ?? 0,
  budgetAtCompletion: value.budgetAtCompletion ?? 0,
  actualCost: value.actualCost ?? 0,
  baselines: value.baselines ?? [],
  dependencies: value.dependencies ?? [],
});

const snapshot = (tasks: ScheduleTask[]): ScheduleSnapshot => ({
  schemaVersion: SCHEDULE_SNAPSHOT_SCHEMA_VERSION,
  sourceFileName: "plan.xlsx",
  statusDate: "2026-07-10",
  tasks,
  metadata: null,
});

describe("schedule analysis", () => {
  it("matches an exported Excel row by its database key before editable fields", () => {
    const current = [task({ id: "db-1", databaseId: "db-1", externalUid: "100", taskCode: "Task001", taskName: "原名称" })];
    const incoming = [task({ id: "edited-code", databaseId: "db-1", externalUid: "edited-code", taskCode: "edited-code", taskName: "新名称" })];
    expect(matchScheduleTasks(current, incoming)[0]).toMatchObject({ currentTaskId: "db-1", rule: "DATABASE_ID", confidence: 1 });
  });

  it("matches tasks by stable identifiers before names", () => {
    const current = [task({ id: "db-1", externalUid: "100", taskCode: "Task001", taskName: "原名称" })];
    const incoming = [task({ id: "file-1", externalUid: "100", taskCode: "Other", taskName: "新名称" })];
    expect(matchScheduleTasks(current, incoming)[0]).toMatchObject({ currentTaskId: "db-1", rule: "EXTERNAL_UID", confidence: 1 });
  });

  it("detects dependency cycles", () => {
    const tasks = [
      task({ id: "a", taskName: "A", dependencies: [{ predecessorTaskId: "c", type: 1, lag: 0, lagFormat: 7 }] }),
      task({ id: "b", taskName: "B", dependencies: [{ predecessorTaskId: "a", type: 1, lag: 0, lagFormat: 7 }] }),
      task({ id: "c", taskName: "C", dependencies: [{ predecessorTaskId: "b", type: 1, lag: 0, lagFormat: 7 }] }),
    ];
    expect(findScheduleCycles(tasks)).toHaveLength(1);
    expect(analyzeScheduleIssues(tasks, "2026-07-01").some((issue) => issue.ruleId === "SCHEDULE_DEPENDENCY_CYCLE")).toBe(true);
  });

  it("detects FS dependency and baseline conflicts with impact chains", () => {
    const tasks = [
      task({ id: "a", taskCode: "Task001", taskName: "A", startDate: "2026-07-01", finishDate: "2026-07-05" }),
      task({ id: "b", taskCode: "Task002", taskName: "B", startDate: "2026-07-04", finishDate: "2026-07-08", baselineFinishDate: "2026-07-06", dependencies: [{ predecessorTaskId: "a", type: 1, lag: 0, lagFormat: 7 }] }),
      task({ id: "c", taskCode: "Task003", taskName: "C", startDate: "2026-07-09", finishDate: "2026-07-10", dependencies: [{ predecessorTaskId: "b", type: 1, lag: 0, lagFormat: 7 }] }),
    ];
    const issues = analyzeScheduleIssues(tasks, "2026-07-01");
    expect(issues.some((issue) => issue.ruleId === "SCHEDULE_DEPENDENCY_CONFLICT")).toBe(true);
    expect(issues.find((issue) => issue.ruleId === "SCHEDULE_BASELINE_DELAY")?.impactTaskIds).toEqual(["c"]);
  });

  it("produces reproducible changes, additions and removals", () => {
    const current = snapshot([
      task({ id: "db-1", externalUid: "1", taskName: "A", progress: 10 }),
      task({ id: "db-2", externalUid: "2", taskName: "B" }),
    ]);
    const incoming = snapshot([
      task({ id: "file-1", externalUid: "1", taskName: "A", progress: 50 }),
      task({ id: "file-3", externalUid: "3", taskName: "C" }),
    ]);
    const result = analyzeSchedule(current, incoming);
    expect(result.summary).toMatchObject({ matched: 1, added: 1, removedCandidates: 1 });
    expect(result.changes).toContainEqual(expect.objectContaining({ field: "progress", before: 10, after: 50 }));
  });

  it("detects overlapping assignments for the same resource", () => {
    const incoming = snapshot([
      task({ id: "1", externalUid: "1", taskCode: "Task001", taskName: "A", startDate: "2026-07-01", finishDate: "2026-07-05" }),
      task({ id: "2", externalUid: "2", taskCode: "Task002", taskName: "B", startDate: "2026-07-04", finishDate: "2026-07-08" }),
    ]);
    incoming.metadata = {
      projectSettings: {},
      calendars: {},
      resources: { Resource: [{ UID: "R1", Name: "张三" }] },
      assignments: { Assignment: [
        { UID: "A1", TaskUID: "1", ResourceUID: "R1" },
        { UID: "A2", TaskUID: "2", ResourceUID: "R1" },
      ] },
      taskUidMap: {},
    };
    expect(analyzeSchedule(snapshot([]), incoming).issues)
      .toContainEqual(expect.objectContaining({ ruleId: "SCHEDULE_RESOURCE_OVERLAP", taskCodes: ["Task001", "Task002"] }));
  });
});
