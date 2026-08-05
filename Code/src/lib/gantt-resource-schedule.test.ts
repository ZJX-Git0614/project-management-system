import { describe, expect, it } from "vitest";

import {
  applyResourceScheduleCandidate,
  createResourceScheduleCandidates,
  detectResourceConflicts,
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

  it("用户选择方案后可调整历史迁移形成的 FIXED 任务，但仍保护 MANUAL 任务", () => {
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

    expect(minimal.applicable).toBe(true);
    expect(minimal.changes).toContainEqual(expect.objectContaining({
      taskId: "legacy-fixed",
      startDate: "2026-01-03",
      finishDate: "2026-01-04",
    }));
    expect(minimal.changes).not.toContainEqual(expect.objectContaining({ taskId: "manual" }));
  });

  it("候选包含快照标识和三类可比较指标", () => {
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
});
