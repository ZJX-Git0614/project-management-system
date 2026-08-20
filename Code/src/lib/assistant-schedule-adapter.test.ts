import { describe, expect, it } from "vitest";

import {
  buildAssistantScheduleContextV1,
  type AssistantScheduleTaskSource,
} from "@/lib/assistant-schedule-adapter";
import {
  assertAssistantScheduleContextV1,
  ASSISTANT_SCHEDULE_SCHEMA_VERSION,
} from "@/lib/assistant-schedule-contract";
import { calculateEarnedValue } from "@/lib/earned-value";

const timestamp = new Date("2026-07-01T00:00:00.000Z");

const tasks: AssistantScheduleTaskSource[] = [
  {
    id: "task-1",
    createdAt: timestamp,
    updatedAt: timestamp,
    projectId: "project-1",
    parentId: null,
    taskCode: "Task1",
    taskCategory: "设计",
    taskName: "方案设计",
    startDate: "2026-07-01",
    finishDate: "2026-07-03",
    durationDays: 3,
    durationMinutes: 1_440,
    durationFormat: 7,
    actualStartDate: "2026-07-01",
    actualEndDate: "",
    progress: 50,
    predecessorTask: "",
    taskMode: "AUTO",
    isMilestone: false,
    externalUid: "11",
    wbsCode: "1",
    outlineNumber: "1",
    calendarUid: "1",
    constraintType: 0,
    constraintDate: "2026-07-01",
    baselineStartDate: "2026-07-01",
    baselineFinishDate: "2026-07-03",
    baselineCost: 1_000,
    budgetAtCompletion: 1_000,
    actualCost: 400,
    baselines: [{ Number: 0, Cost: 1_000 }],
    sortOrder: 1,
    predecessorDependencies: [],
  },
  {
    id: "task-2",
    createdAt: timestamp,
    updatedAt: timestamp,
    projectId: "project-1",
    parentId: "task-1",
    taskCode: "Task1.1",
    taskCategory: "设计",
    taskName: "设计评审",
    startDate: "2026-07-04",
    finishDate: "2026-07-04",
    durationDays: 1,
    durationMinutes: 0,
    durationFormat: 7,
    actualStartDate: "",
    actualEndDate: "",
    progress: 0,
    predecessorTask: "方案设计",
    taskMode: "MANUAL",
    isMilestone: true,
    externalUid: "12",
    wbsCode: "1.1",
    outlineNumber: "1.1",
    calendarUid: "1",
    constraintType: 4,
    constraintDate: "2026-07-04",
    baselineStartDate: "2026-07-04",
    baselineFinishDate: "2026-07-04",
    baselineCost: 500,
    budgetAtCompletion: 500,
    actualCost: 100,
    baselines: [],
    sortOrder: 2,
    predecessorDependencies: [{
      id: "dependency-1",
      createdAt: timestamp,
      updatedAt: timestamp,
      projectId: "project-1",
      predecessorTaskId: "task-1",
      successorTaskId: "task-2",
      type: 3,
      lag: 480,
      lagFormat: 7,
      predecessorTask: { id: "task-1", taskCode: "Task1", taskName: "方案设计" },
    }],
  },
];

describe("assistant schedule adapter", () => {
  it("builds a versioned contract with every current task and dependency field", () => {
    const schedule = buildAssistantScheduleContextV1({
      projectId: "project-1",
      statusDate: "2026-07-03",
      tasks,
      metadata: {
        sourceFileName: "project.xml",
        updatedAt: timestamp,
        resources: {
          Resource: [{ UID: 8, Name: "工程师", Type: 1, MaxUnits: 1, EmailAddress: "engineer@example.com" }],
        },
        assignments: {
          Assignment: [{
            UID: 3,
            TaskUID: 11,
            ResourceUID: 8,
            Units: 0.5,
            Start: "2026-07-01T08:00:00",
            Finish: "2026-07-03T17:00:00",
            Work: "PT12H0M0S",
          }],
        },
        taskUidMap: { 11: "task-1", 12: "task-2" },
      },
    });

    expect(schedule.schemaVersion).toBe(ASSISTANT_SCHEDULE_SCHEMA_VERSION);
    expect(schedule.tasks[0]).toMatchObject({
      id: "task-1",
      projectId: "project-1",
      parentId: null,
      taskCode: "Task1",
      taskCategory: "设计",
      taskName: "方案设计",
      startDate: "2026-07-01",
      finishDate: "2026-07-03",
      durationDays: 3,
      durationMinutes: 1_440,
      durationFormat: 7,
      actualStartDate: "2026-07-01",
      actualEndDate: "",
      progress: 50,
      predecessorTask: "",
      taskMode: "AUTO",
      isMilestone: false,
      externalUid: "11",
      wbsCode: "1",
      outlineNumber: "1",
      calendarUid: "1",
      constraintType: 0,
      constraintDate: "2026-07-01",
      baselineStartDate: "2026-07-01",
      baselineFinishDate: "2026-07-03",
      baselineCost: 1_000,
      budgetAtCompletion: 1_000,
      actualCost: 400,
      baselines: [{ Number: 0, Cost: 1_000 }],
      sortOrder: 1,
    });
    expect(schedule.dependencies[0]).toMatchObject({
      predecessorTaskId: "task-1",
      successorTaskId: "task-2",
      predecessorTaskCode: "Task1",
      successorTaskCode: "Task1.1",
      type: 3,
      typeLabel: "SS",
      lag: 480,
      lagFormat: 7,
    });
    expect(schedule.tasks[0].successorDependencies).toHaveLength(1);
    expect(schedule.tasks[1].predecessorDependencies).toHaveLength(1);
    expect(schedule.criticalPath).toEqual({ status: "CALCULATED", criticalTaskIds: ["task-2"] });
  });

  it("normalizes imported resources and assignments to database task ids", () => {
    const schedule = buildAssistantScheduleContextV1({
      projectId: "project-1",
      tasks,
      metadata: {
        sourceFileName: "project.xml",
        updatedAt: timestamp,
        resources: { Resource: { UID: 8, Name: "工程师", MaxUnits: 1 } },
        assignments: { Assignment: { UID: 3, TaskUID: 11, ResourceUID: 8, Work: "PT8H30M0S" } },
        taskUidMap: { 11: "task-1" },
      },
    });

    expect(schedule.resources).toEqual([expect.objectContaining({ uid: "8", name: "工程师", maxUnits: 1 })]);
    expect(schedule.assignments).toEqual([expect.objectContaining({
      uid: "3",
      taskUid: "11",
      taskId: "task-1",
      resourceUid: "8",
      resourceName: "工程师",
      workMinutes: 510,
    })]);
  });

  it("reuses the earned-value engine and rejects unsupported contracts", () => {
    const schedule = buildAssistantScheduleContextV1({
      projectId: "project-1",
      statusDate: "2026-07-03",
      tasks,
    });
    const expected = calculateEarnedValue(tasks, "2026-07-03");

    expect(schedule.earnedValue.summary).toEqual(expected.summary);
    expect(schedule.tasks[0].earnedValue).toMatchObject({
      pv: expected.rows[0].pv,
      ev: expected.rows[0].ev,
      sv: expected.rows[0].sv,
      cv: expected.rows[0].cv,
    });
    expect(() => assertAssistantScheduleContextV1({ ...schedule, schemaVersion: 2 }))
      .toThrow("不支持的助手计划协议版本：2");
    expect(() => assertAssistantScheduleContextV1({
      ...schedule,
      tasks: [{ ...schedule.tasks[0], taskCode: undefined }],
    })).toThrow("助手计划协议缺少必需字段");
  });

  it("keeps raw task fields unchanged while earned value uses its own date fallback", () => {
    const schedule = buildAssistantScheduleContextV1({
      projectId: "project-1",
      tasks: [{ ...tasks[0], finishDate: "" }],
    });

    expect(schedule.tasks[0].finishDate).toBe("");
  });
});
