import { describe, expect, it } from "vitest";

import {
  applyResourceScheduleCandidate,
  createResourceScheduleCandidates,
  detectResourceConflicts,
  detectResourceScheduleIssues,
  resourceScheduleSnapshotHash,
  type ResourceSchedulingTask,
} from "@/lib/gantt-resource-schedule";

const task = (overrides: Partial<ResourceSchedulingTask> = {}): ResourceSchedulingTask => ({
  id: "task-1",
  projectId: "project-1",
  projectName: "项目一",
  taskName: "任务一",
  parentId: null,
  isLeaf: true,
  ownerKeys: ["account:user-1"],
  startDate: "2026-01-01",
  finishDate: "2026-01-02",
  durationDays: 2,
  progress: 0,
  taskMode: "AUTO",
  sortOrder: 1,
  predecessorDependencies: [],
  isCurrentProject: true,
  ...overrides,
});

describe("detectResourceConflicts", () => {
  it("只检查有负责人的叶子执行任务，并忽略已完成或零工期任务", () => {
    const conflicts = detectResourceConflicts([
      task(),
      task({ id: "task-2", taskName: "任务二", startDate: "2026-01-02", finishDate: "2026-01-03" }),
      task({ id: "parent", taskName: "父任务", isLeaf: false }),
      task({ id: "unassigned", taskName: "未分配", ownerKeys: [] }),
      task({ id: "completed", taskName: "已完成", progress: 100 }),
      task({ id: "zero", taskName: "零工期", durationDays: 0, finishDate: "" }),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ ownerKey: "account:user-1", taskIds: ["task-1", "task-2"] });
  });

  it("多人任务占用每一位负责人", () => {
    const conflicts = detectResourceConflicts([
      task({ ownerKeys: ["account:user-1", "account:user-2"] }),
      task({ id: "task-2", ownerKeys: ["account:user-2"] }),
    ]);

    expect(conflicts.map((item) => item.ownerKey)).toEqual(["account:user-2"]);
  });
});

describe("createResourceScheduleCandidates", () => {
  it("将同一负责人的自动任务串行，并保持业务依赖不变", () => {
    const tasks = [
      task(),
      task({ id: "task-2", taskName: "任务二", durationDays: 1, finishDate: "2026-01-01", sortOrder: 2 }),
    ];
    const result = createResourceScheduleCandidates({
      tasks,
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-10",
    });
    const minimal = result.candidates.find((candidate) => candidate.kind === "MINIMAL_CHANGE")!;
    const applied = applyResourceScheduleCandidate(tasks, minimal);

    expect(applied.find((item) => item.id === "task-2")).toMatchObject({
      startDate: "2026-01-03",
      finishDate: "2026-01-03",
      predecessorDependencies: [],
    });
    expect(detectResourceConflicts(applied)).toHaveLength(0);
    expect(minimal.metrics.movedTaskCount).toBe(1);
  });

  it("把其他项目和固定任务当作不可移动的资源占用", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({ durationDays: 2 }),
        task({
          id: "external",
          projectId: "project-2",
          projectName: "项目二",
          taskName: "外部任务",
          startDate: "2026-01-01",
          finishDate: "2026-01-03",
          durationDays: 3,
          taskMode: "MANUAL",
          isCurrentProject: false,
        }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-10",
    });
    const minimal = result.candidates.find((candidate) => candidate.kind === "MINIMAL_CHANGE")!;

    expect(minimal.changes).toEqual([
      expect.objectContaining({ taskId: "task-1", startDate: "2026-01-04", finishDate: "2026-01-05" }),
    ]);
  });

  it("多人任务必须同时避开所有负责人的占用", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({ id: "reserved-a", ownerKeys: ["account:user-1"], taskMode: "MANUAL" }),
        task({ id: "reserved-b", ownerKeys: ["account:user-2"], startDate: "2026-01-03", finishDate: "2026-01-04", taskMode: "MANUAL" }),
        task({ id: "shared", ownerKeys: ["account:user-1", "account:user-2"], durationDays: 1, finishDate: "2026-01-01", sortOrder: 3 }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-10",
    });
    const minimal = result.candidates.find((candidate) => candidate.kind === "MINIMAL_CHANGE")!;

    expect(minimal.changes).toContainEqual(expect.objectContaining({
      taskId: "shared",
      startDate: "2026-01-05",
      finishDate: "2026-01-05",
    }));
  });

  it("固定或进行中任务互相冲突时不生成虚假的可应用变化", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({ taskMode: "MANUAL" }),
        task({ id: "task-2", progress: 50, taskMode: "AUTO" }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-10",
    });

    expect(result.candidates.every((candidate) => !candidate.applicable)).toBe(true);
    expect(result.candidates.every((candidate) => candidate.remainingConflicts.length === 1)).toBe(true);
  });

  it("手动、锁定和历史 FIXED 任务都不会被自动排期移动", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({ id: "manual", taskMode: "MANUAL" }),
        task({ id: "legacy-fixed", taskMode: "FIXED", sortOrder: 2 }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-10",
    });
    const minimal = result.candidates.find((candidate) => candidate.kind === "MINIMAL_CHANGE")!;

    expect(minimal.applicable).toBe(false);
    expect(minimal.changes).not.toContainEqual(expect.objectContaining({ taskId: "legacy-fixed" }));
    expect(minimal.changes).not.toContainEqual(expect.objectContaining({ taskId: "manual" }));
  });

  it("将四种新排期模式中的固定模式视为不可自动移动任务", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({ id: "forward", taskMode: "DURATION_FORWARD" }),
        task({ id: "backward", taskMode: "DURATION_BACKWARD", sortOrder: 2 }),
        task({ id: "fixed", taskMode: "DATES_FIXED", sortOrder: 3 }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-10",
    });
    const minimal = result.candidates.find((candidate) => candidate.kind === "MINIMAL_CHANGE")!;

    expect(minimal.changes).toEqual([]);
    expect(minimal.applicable).toBe(false);
  });

  it("项目硬完成时间会阻止自动任务越界", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({ startDate: "2026-01-01", finishDate: "2026-01-02", durationDays: 2 }),
        task({ id: "task-2", startDate: "2026-01-01", finishDate: "2026-01-02", durationDays: 2, sortOrder: 2 }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-10",
      hardFinishDate: "2026-01-02",
    });
    const minimal = result.candidates.find((candidate) => candidate.kind === "MINIMAL_CHANGE")!;

    expect(minimal.issues).toContainEqual(expect.objectContaining({ code: "PROJECT_HARD_FINISH_VIOLATION", severity: "ERROR" }));
    expect(minimal.applicable).toBe(false);
  });

  it("候选包含快照标识和四类可比较指标", () => {
    const result = createResourceScheduleCandidates({
      tasks: [task(), task({ id: "task-2", sortOrder: 2 })],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-02",
    });

    expect(result.snapshotHash).toHaveLength(64);
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual([
      "MINIMAL_CHANGE",
      "EARLIEST_FINISH",
      "ON_TIME",
      "RESOURCE_SMOOTHING",
    ]);
    result.candidates.forEach((candidate) => {
      expect(candidate.metrics).toEqual(expect.objectContaining({
        completionDate: expect.any(String),
        delayedDays: expect.any(Number),
        movedTaskCount: expect.any(Number),
        totalShiftDays: expect.any(Number),
      }));
    });
  });

  it("资源排期约束变化会使候选快照失效", () => {
    const original = [task()];
    const constrained = [task({ resourceNotBeforeDate: "2026-01-05" })];

    expect(resourceScheduleSnapshotHash(constrained)).not.toBe(resourceScheduleSnapshotHash(original));
  });

  it("不把仅发生在其他项目之间的冲突计入当前项目", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({ ownerKeys: ["account:current-owner"] }),
        task({ id: "external-a", projectId: "project-2", isCurrentProject: false }),
        task({ id: "external-b", projectId: "project-3", isCurrentProject: false, sortOrder: 2 }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-10",
    });

    expect(result.conflicts).toEqual([]);
    expect(result.candidates.every((candidate) => candidate.remainingConflicts.length === 0)).toBe(true);
  });

  it("对超出成员分配比例的工作量给出明确告警", () => {
    const issues = detectResourceScheduleIssues([
      task({
        durationDays: 1,
        finishDate: "2026-01-01",
        effortDriven: true,
        estimatedWorkHours: 7.5,
        ownerAssignments: [{
          ownerKey: "account:user-1",
          unitsPercent: 50,
          capacityHoursPerDay: 7.5,
        }],
      }),
    ]);

    expect(issues).toContainEqual(expect.objectContaining({
      code: "RESOURCE_ASSIGNMENT_EXCEEDS_ALLOCATION",
      taskIds: ["task-1"],
    }));
  });

  it("检测到循环依赖时停止自动排期，不生成伪解", () => {
    const tasks = [
      task({ id: "a", predecessorDependencies: [{ predecessorTaskId: "b" }] }),
      task({ id: "b", sortOrder: 2, predecessorDependencies: [{ predecessorTaskId: "a" }] }),
    ];
    const result = createResourceScheduleCandidates({
      tasks,
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-10",
    });

    expect(result.issues).toContainEqual(expect.objectContaining({ code: "DEPENDENCY_CYCLE", severity: "ERROR" }));
    expect(result.candidates.every((candidate) => !candidate.applicable)).toBe(true);
    expect(result.candidates.every((candidate) => candidate.changes.length === 0)).toBe(true);
  });

  it("手动父任务边界会校验子任务是否越界", () => {
    const issues = detectResourceScheduleIssues([
      task({
        id: "parent",
        taskName: "父任务",
        isLeaf: false,
        ownerKeys: [],
        startDate: "2026-01-02",
        finishDate: "2026-01-02",
        durationDays: 1,
        parentBoundaryMode: "LOCKED",
      }),
      task({
        id: "child",
        taskName: "子任务",
        parentId: "parent",
        startDate: "2026-01-01",
        finishDate: "2026-01-02",
        durationDays: 2,
        sortOrder: 2,
      }),
    ]);

    expect(issues).toContainEqual(expect.objectContaining({
      code: "PARENT_BOUNDARY_VIOLATION",
      severity: "ERROR",
      taskIds: expect.arrayContaining(["parent", "child"]),
    }));
  });

  it("自动排期会在父任务计划窗口内为未排期子任务倒排", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({
          id: "parent",
          taskName: "父任务",
          isLeaf: false,
          ownerKeys: [],
          startDate: "2026-01-01",
          finishDate: "2026-01-05",
          durationDays: 5,
        }),
        task({
          id: "child",
          taskName: "未排期子任务",
          parentId: "parent",
          startDate: "",
          finishDate: "",
          durationDays: 2,
          sortOrder: 2,
        }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-05",
    });
    const minimal = result.candidates.find((candidate) => candidate.kind === "MINIMAL_CHANGE")!;

    expect(result.issues).toContainEqual(expect.objectContaining({ code: "MISSING_START_DATE", taskIds: ["child"] }));
    expect(minimal.applicable).toBe(true);
    expect(minimal.changes).toContainEqual(expect.objectContaining({
      taskId: "child",
      startDate: "2026-01-04",
      finishDate: "2026-01-05",
    }));
    expect(minimal.issues).not.toContainEqual(expect.objectContaining({ id: "missing-start:child" }));
  });

  it("同一父任务窗口内的未排期任务按优先级保护靠近完成边界的工作", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({
          id: "parent",
          taskName: "父任务",
          isLeaf: false,
          ownerKeys: [],
          startDate: "2026-01-01",
          finishDate: "2026-01-05",
          durationDays: 5,
        }),
        task({
          id: "high",
          taskName: "高优先级",
          parentId: "parent",
          startDate: "",
          finishDate: "",
          durationDays: 2,
          schedulePriority: 900,
          sortOrder: 2,
        }),
        task({
          id: "low",
          taskName: "低优先级",
          parentId: "parent",
          startDate: "",
          finishDate: "",
          durationDays: 2,
          schedulePriority: 100,
          sortOrder: 3,
        }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-05",
    });
    const minimal = result.candidates.find((candidate) => candidate.kind === "MINIMAL_CHANGE")!;

    expect(minimal.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "high", startDate: "2026-01-04", finishDate: "2026-01-05" }),
      expect.objectContaining({ taskId: "low", startDate: "2026-01-02", finishDate: "2026-01-03" }),
    ]));
    expect(minimal.resourceConstrainedTaskIds).toContain("low");
  });

  it("资源平滑不会为了消除冲突而延长原有项目完工日期", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({ id: "first", startDate: "2026-01-01", finishDate: "2026-01-02", durationDays: 2 }),
        task({ id: "second", startDate: "2026-01-01", finishDate: "2026-01-01", durationDays: 1, sortOrder: 2 }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-02",
    });
    const smoothing = result.candidates.find((candidate) => candidate.kind === "RESOURCE_SMOOTHING")!;

    expect(smoothing.applicable).toBe(false);
    expect(smoothing.changes).toEqual([]);
    expect(smoothing.issues).toContainEqual(expect.objectContaining({ code: "RESOURCE_SMOOTHING_LIMIT" }));
  });

  it("限定父级范围后只移动所选分支，其他自动任务作为资源占用保留", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({
          id: "selected-parent",
          taskName: "已选父任务",
          isLeaf: false,
          ownerKeys: [],
          startDate: "2026-01-01",
          finishDate: "2026-01-06",
          durationDays: 6,
        }),
        task({
          id: "selected-leaf",
          taskName: "已选叶子任务",
          parentId: "selected-parent",
          startDate: "2026-01-01",
          finishDate: "2026-01-02",
          durationDays: 2,
          sortOrder: 2,
        }),
        task({
          id: "other-parent",
          taskName: "未选父任务",
          isLeaf: false,
          ownerKeys: [],
          startDate: "2026-01-01",
          finishDate: "2026-01-06",
          durationDays: 6,
          sortOrder: 3,
        }),
        task({
          id: "other-leaf",
          taskName: "未选叶子任务",
          parentId: "other-parent",
          startDate: "2026-01-01",
          finishDate: "2026-01-02",
          durationDays: 2,
          sortOrder: 4,
        }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-10",
      scopeTaskIds: ["selected-leaf"],
      modeOverride: "DURATION_FORWARD",
    });
    const minimal = result.candidates.find((candidate) => candidate.kind === "MINIMAL_CHANGE")!;

    expect(minimal.changes).toContainEqual(expect.objectContaining({
      taskId: "selected-leaf",
      startDate: "2026-01-03",
      finishDate: "2026-01-04",
      taskMode: "DURATION_FORWARD",
    }));
    expect(minimal.changes).not.toContainEqual(expect.objectContaining({ taskId: "other-leaf" }));
  });

  it("自动排期在负责人或排期锚点缺失时只给出阻断提示", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({
          id: "parent",
          taskName: "未设边界父任务",
          isLeaf: false,
          ownerKeys: [],
          startDate: "",
          finishDate: "",
          durationDays: 0,
        }),
        task({
          id: "unscheduled",
          taskName: "缺少排期条件",
          parentId: "parent",
          ownerKeys: [],
          startDate: "",
          finishDate: "",
          durationDays: 2,
          sortOrder: 2,
        }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "",
      scopeTaskIds: ["unscheduled"],
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MISSING_RESPONSIBLE_PERSON", severity: "ERROR", taskIds: ["unscheduled"] }),
      expect.objectContaining({ code: "MISSING_SCHEDULE_ANCHOR", severity: "ERROR", taskIds: ["unscheduled"] }),
    ]));
    expect(result.candidates.every((candidate) => !candidate.applicable)).toBe(true);
  });
});
