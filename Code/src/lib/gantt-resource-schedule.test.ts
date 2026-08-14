import { describe, expect, it } from "vitest";

import {
  FORMAL_RESOURCE_SCHEDULE_CANDIDATE_KIND,
  applyResourceScheduleCandidate,
  createResourceScheduleCandidates as createFormalResourceScheduleCandidates,
  detectResourceConflicts,
  detectResourceScheduleIssues,
  resourceScheduleSnapshotHash,
  type ResourceSchedulingTask,
} from "@/lib/gantt-resource-schedule";

const createResourceScheduleCandidates = (
  params: Parameters<typeof createFormalResourceScheduleCandidates>[0],
) => createFormalResourceScheduleCandidates({
  projectStartDate: "2026-01-01",
  ...params,
});

const formalCandidate = (result: ReturnType<typeof createFormalResourceScheduleCandidates>) => {
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]?.kind).toBe(FORMAL_RESOURCE_SCHEDULE_CANDIDATE_KIND);
  return result.candidates[0]!;
};

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
  it("项目 T0 未确定时以相对工作日计算 FS 串行任务", () => {
    const tasks = [
      task({
        id: "task-a",
        taskName: "A",
        startDate: "",
        finishDate: "",
        durationDays: 2,
      }),
      task({
        id: "task-b",
        taskName: "B",
        startDate: "",
        finishDate: "",
        durationDays: 1,
        sortOrder: 2,
        predecessorDependencies: [{ predecessorTaskId: "task-a" }],
      }),
    ];
    const result = createFormalResourceScheduleCandidates({
      tasks,
      currentProjectId: "project-1",
      calendarMode: "WORKING_DAYS",
      projectStartDate: "",
      expectedEndDate: "",
    });
    const candidate = formalCandidate(result);
    const applied = applyResourceScheduleCandidate(tasks, candidate);

    expect(candidate.relativeSchedule).toBe(true);
    expect(candidate.applicable).toBe(true);
    expect(candidate.metrics.relativeCompletionOffsetDays).toBe(2);
    expect(candidate.issues).not.toContainEqual(expect.objectContaining({
      code: "MISSING_START_DATE",
    }));
    expect(candidate.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: "task-a",
        startDate: "",
        finishDate: "",
        relativeStartOffsetDays: 0,
        relativeFinishOffsetDays: 1,
      }),
      expect.objectContaining({
        taskId: "task-b",
        startDate: "",
        finishDate: "",
        relativeStartOffsetDays: 2,
        relativeFinishOffsetDays: 2,
      }),
    ]));
    expect(applied.find((item) => item.id === "task-a")).toMatchObject({
      relativeStartOffsetDays: 0,
      relativeFinishOffsetDays: 1,
    });
    expect(applied.find((item) => item.id === "task-b")).toMatchObject({
      relativeStartOffsetDays: 2,
      relativeFinishOffsetDays: 2,
    });
  });

  it("项目 T0 未确定时阻止倒排，避免伪造完成边界", () => {
    const result = createFormalResourceScheduleCandidates({
      tasks: [task({ startDate: "", finishDate: "" })],
      currentProjectId: "project-1",
      calendarMode: "WORKING_DAYS",
      projectStartDate: "",
      expectedEndDate: "",
      modeOverride: "DURATION_BACKWARD",
    });
    const candidate = formalCandidate(result);

    expect(candidate.applicable).toBe(false);
    expect(candidate.changes).toEqual([]);
    expect(candidate.issues).toContainEqual(expect.objectContaining({
      id: "relative-schedule-backward-mode",
      severity: "ERROR",
    }));
  });

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
    const candidate = formalCandidate(result);
    const applied = applyResourceScheduleCandidate(tasks, candidate);

    expect(applied.find((item) => item.id === "task-2")).toMatchObject({
      startDate: "2026-01-03",
      finishDate: "2026-01-03",
      predecessorDependencies: [],
    });
    expect(detectResourceConflicts(applied)).toHaveLength(0);
    expect(candidate.metrics.movedTaskCount).toBe(1);
    expect(candidate.resourceCriticalChainLinks).toEqual([
      expect.objectContaining({
        predecessorTaskId: "task-1",
        successorTaskId: "task-2",
        ownerKey: "account:user-1",
      }),
    ]);
    expect(candidate.taskExplanations).toContainEqual(expect.objectContaining({
      taskId: "task-2",
      resourceCritical: true,
      reasonCodes: expect.arrayContaining(["RESOURCE_CRITICAL_CHAIN"]),
    }));
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
    const candidate = formalCandidate(result);

    expect(candidate.changes).toEqual([
      expect.objectContaining({ taskId: "task-1", startDate: "2026-01-04", finishDate: "2026-01-05" }),
    ]);
  });

  it("末级任务存在多名负责人时阻断正式自动排期", () => {
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
    const candidate = formalCandidate(result);

    expect(candidate.applicable).toBe(false);
    expect(candidate.changes).toEqual([]);
    expect(candidate.issues).toContainEqual(expect.objectContaining({
      code: "MISSING_RESPONSIBLE_PERSON",
      severity: "ERROR",
      taskIds: ["shared"],
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
    const candidate = formalCandidate(result);

    expect(candidate.applicable).toBe(false);
    expect(candidate.changes).not.toContainEqual(expect.objectContaining({ taskId: "legacy-fixed" }));
    expect(candidate.changes).not.toContainEqual(expect.objectContaining({ taskId: "manual" }));
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
    const candidate = formalCandidate(result);

    expect(candidate.changes).toEqual([]);
    expect(candidate.applicable).toBe(false);
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
    const candidate = formalCandidate(result);

    expect(candidate.issues).toContainEqual(expect.objectContaining({ code: "PROJECT_HARD_FINISH_VIOLATION", severity: "ERROR" }));
    expect(candidate.applicable).toBe(false);
  });

  it("正式自动排期包含快照标识和可审计指标", () => {
    const result = createResourceScheduleCandidates({
      tasks: [task(), task({ id: "task-2", sortOrder: 2 })],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-02",
    });

    expect(result.snapshotHash).toHaveLength(64);
    const candidate = formalCandidate(result);
    expect(candidate.metrics).toEqual(expect.objectContaining({
      completionDate: expect.any(String),
      delayedDays: expect.any(Number),
      movedTaskCount: expect.any(Number),
      totalShiftDays: expect.any(Number),
    }));
  });

  it("候选方案给出最终关键路径和逐任务排期依据", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({ id: "task-1", durationDays: 2 }),
        task({
          id: "task-2",
          durationDays: 1,
          startDate: "2026-01-01",
          finishDate: "2026-01-01",
          sortOrder: 2,
          predecessorDependencies: [{ predecessorTaskId: "task-1" }],
        }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-10",
    });
    const candidate = formalCandidate(result);

    expect(candidate.criticalTaskIds).toContain("task-2");
    expect(candidate.taskExplanations).toContainEqual(expect.objectContaining({
      taskId: "task-2",
      reasonCodes: expect.arrayContaining(["DEPENDENCY"]),
      details: expect.arrayContaining([expect.stringContaining("紧前")]),
    }));
  });

  it("建议工期只返回本次自动排期范围内的任务", () => {
    const tasks = [
      task({ id: "parent-a", isLeaf: false, durationDays: 7, ownerKeys: [], parentId: null }),
      task({ id: "a-1", parentId: "parent-a", durationDays: 0, finishDate: "", sortOrder: 2 }),
      task({ id: "parent-b", isLeaf: false, durationDays: 5, ownerKeys: [], parentId: null, sortOrder: 3 }),
      task({ id: "b-1", parentId: "parent-b", durationDays: 0, finishDate: "", sortOrder: 4 }),
    ];
    const result = createResourceScheduleCandidates({
      tasks,
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-10",
      scopeTaskIds: ["a-1"],
    });

    expect(result.durationSuggestions.map((suggestion) => suggestion.taskId)).toEqual(["a-1"]);
    expect(result.durationSuggestionIssues.every((issue) => issue.taskIds.includes("a-1"))).toBe(true);
  });

  it("将符合规则的系统建议工期纳入正式排期并在应用时一并写入", () => {
    const tasks = [
      task({ id: "parent", isLeaf: false, ownerKeys: [], durationDays: 7, startDate: "", finishDate: "" }),
      ...Array.from({ length: 5 }, (_, index) => task({
        id: `child-${index + 1}`,
        parentId: "parent",
        taskName: `子任务 ${index + 1}`,
        startDate: "",
        finishDate: "",
        durationDays: 0,
        sortOrder: index + 2,
      })),
    ];
    const result = createFormalResourceScheduleCandidates({
      tasks,
      currentProjectId: "project-1",
      calendarMode: "WORKING_DAYS",
      projectStartDate: "",
      expectedEndDate: "",
    });
    const candidate = formalCandidate(result);
    const applied = applyResourceScheduleCandidate(tasks, candidate);

    expect(candidate.applicable).toBe(true);
    expect(candidate.issues).not.toContainEqual(expect.objectContaining({ code: "MISSING_DURATION" }));
    expect(candidate.changes.filter((change) => typeof change.durationDays === "number").map((change) => change.durationDays))
      .toEqual([1, 1, 1, 1, 3]);
    expect(applied.filter((item) => item.parentId === "parent").map((item) => item.durationDays))
      .toEqual([1, 1, 1, 1, 3]);
    expect(applied.filter((item) => item.parentId === "parent").every((item) => item.estimatedWorkHours === item.durationDays * 7.5))
      .toBe(true);
  });

  it("父窗口内的 FS 子任务使用建议工期生成可应用的 T0 正式预览", () => {
    const tasks = [
      task({ id: "parent", isLeaf: false, ownerKeys: [], durationDays: 7, startDate: "", finishDate: "" }),
      task({
        id: "predecessor",
        parentId: "parent",
        taskName: "紧前任务",
        startDate: "",
        finishDate: "",
        durationDays: 0,
        sortOrder: 2,
      }),
      task({
        id: "successor",
        parentId: "parent",
        taskName: "紧后任务",
        startDate: "",
        finishDate: "",
        durationDays: 0,
        sortOrder: 3,
        predecessorDependencies: [{ predecessorTaskId: "predecessor" }],
      }),
    ];
    const result = createFormalResourceScheduleCandidates({
      tasks,
      currentProjectId: "project-1",
      calendarMode: "WORKING_DAYS",
      projectStartDate: "",
      expectedEndDate: "",
    });
    const candidate = formalCandidate(result);
    const predecessorChange = candidate.changes.find((change) => change.taskId === "predecessor");
    const successorChange = candidate.changes.find((change) => change.taskId === "successor");

    expect(candidate.applicable).toBe(true);
    expect(candidate.issues).not.toContainEqual(expect.objectContaining({ code: "MISSING_DURATION" }));
    expect(result.durationSuggestions.map((suggestion) => suggestion.suggestedDurationDays)).toEqual([1, 6]);
    expect(predecessorChange).toMatchObject({
      durationDays: 1,
      relativeStartOffsetDays: 0,
      relativeFinishOffsetDays: 0,
    });
    expect(successorChange).toMatchObject({
      durationDays: 6,
      relativeStartOffsetDays: 1,
      relativeFinishOffsetDays: 6,
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

  it("正式自动排期以项目 T0 而非父任务汇总日期为未排期子任务提供起点", () => {
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
    const candidate = formalCandidate(result);

    expect(result.issues).toContainEqual(expect.objectContaining({ code: "MISSING_START_DATE", taskIds: ["child"] }));
    expect(candidate.applicable).toBe(true);
    expect(candidate.changes).toContainEqual(expect.objectContaining({
      taskId: "child",
      startDate: "2026-01-01",
      finishDate: "2026-01-02",
    }));
    expect(candidate.issues).not.toContainEqual(expect.objectContaining({ id: "missing-start:child" }));
  });

  it("同一负责人下的未排期任务让高优先级任务先占用项目 T0 后的资源", () => {
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
    const candidate = formalCandidate(result);

    expect(candidate.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "high", startDate: "2026-01-01", finishDate: "2026-01-02" }),
      expect.objectContaining({ taskId: "low", startDate: "2026-01-03", finishDate: "2026-01-04" }),
    ]));
    expect(candidate.resourceConstrainedTaskIds).toContain("low");
  });

  it("非 FS 紧前关系会阻断自动排期，而不会被误算为其他关系", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({ id: "predecessor" }),
        task({
          id: "successor",
          sortOrder: 2,
          predecessorDependencies: [{ predecessorTaskId: "predecessor", type: 3 }],
        }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-10",
    });

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "UNSUPPORTED_DEPENDENCY_TYPE",
      severity: "ERROR",
      taskIds: ["successor", "predecessor"],
    }));
    expect(result.candidates.every((candidate) => !candidate.applicable)).toBe(true);
  });

  it("目标父级边界仅预警，不会阻断可行排期", () => {
    const issues = detectResourceScheduleIssues([
      task({
        id: "target-parent",
        isLeaf: false,
        ownerKeys: [],
        startDate: "2026-01-01",
        finishDate: "2026-01-02",
        durationDays: 2,
        parentBoundaryMode: "TARGET",
      }),
      task({
        id: "late-child",
        parentId: "target-parent",
        startDate: "2026-01-03",
        finishDate: "2026-01-03",
        durationDays: 1,
        sortOrder: 2,
      }),
    ]);

    expect(issues).toContainEqual(expect.objectContaining({
      code: "TARGET_BOUNDARY_MISS",
      severity: "WARNING",
      taskIds: ["late-child", "target-parent"],
    }));
    expect(issues).not.toContainEqual(expect.objectContaining({ code: "PARENT_BOUNDARY_VIOLATION" }));
  });

  it("工期固定倒排沿 FS 依赖反向计算，并让紧前任务先完成", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({
          id: "parent",
          isLeaf: false,
          ownerKeys: [],
          startDate: "2026-01-01",
          finishDate: "2026-01-08",
          durationDays: 8,
          parentBoundaryMode: "LOCKED",
        }),
        task({
          id: "predecessor",
          parentId: "parent",
          startDate: "",
          finishDate: "",
          durationDays: 2,
          schedulePriority: 900,
          sortOrder: 2,
        }),
        task({
          id: "successor",
          parentId: "parent",
          startDate: "",
          finishDate: "",
          durationDays: 2,
          schedulePriority: 100,
          sortOrder: 3,
          predecessorDependencies: [{ predecessorTaskId: "predecessor", type: 1 }],
        }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-08",
      scopeTaskIds: ["predecessor", "successor"],
      modeOverride: "DURATION_BACKWARD",
    });
    const candidate = formalCandidate(result);

    expect(candidate.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "predecessor", startDate: "2026-01-05", finishDate: "2026-01-06", taskMode: "DURATION_BACKWARD" }),
      expect.objectContaining({ taskId: "successor", startDate: "2026-01-07", finishDate: "2026-01-08", taskMode: "DURATION_BACKWARD" }),
    ]));
    expect(candidate.issues).not.toContainEqual(expect.objectContaining({ code: "DEPENDENCY_CONSTRAINT" }));
  });

  it("工期固定倒排不会把计划开始误当成完成端排期锚点", () => {
    const result = createResourceScheduleCandidates({
      tasks: [task({
        id: "backward-with-start-only",
        startDate: "2026-01-01",
        finishDate: "",
        durationDays: 2,
      })],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "",
      modeOverride: "DURATION_BACKWARD",
    });

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "MISSING_SCHEDULE_ANCHOR",
      severity: "ERROR",
      taskIds: ["backward-with-start-only"],
      message: expect.stringContaining("计划完成"),
    }));
    expect(result.candidates.every((candidate) => !candidate.applicable)).toBe(true);
  });

  it("选择范围只控制排期方式覆盖，仍统一求解跨分支自动任务", () => {
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
    const candidate = formalCandidate(result);

    expect(candidate.changes).toContainEqual(expect.objectContaining({
      taskId: "selected-leaf",
      startDate: "2026-01-01",
      finishDate: "2026-01-02",
      taskMode: "DURATION_FORWARD",
    }));
    expect(candidate.changes).toContainEqual(expect.objectContaining({
      taskId: "other-leaf",
      startDate: "2026-01-03",
      finishDate: "2026-01-04",
    }));
    expect(candidate.changes).not.toContainEqual(expect.objectContaining({
      taskId: "other-leaf",
      taskMode: "DURATION_FORWARD",
    }));
  });

  it("相对 T0 自动排期在负责人缺失时只给出阻断提示", () => {
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
      projectStartDate: "",
      scopeTaskIds: ["unscheduled"],
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MISSING_RESPONSIBLE_PERSON", severity: "ERROR", taskIds: ["unscheduled"] }),
    ]));
    expect(result.candidates.every((candidate) => !candidate.applicable)).toBe(true);
  });

  it("父任务依赖会约束后置父任务的入口叶子，而不会把摘要行当成执行任务", () => {
    const result = createResourceScheduleCandidates({
      tasks: [
        task({ id: "parent-a", isLeaf: false, ownerKeys: [], durationDays: 2 }),
        task({ id: "a-1", parentId: "parent-a", durationDays: 1, finishDate: "2026-01-01" }),
        task({ id: "a-2", parentId: "parent-a", durationDays: 1, finishDate: "2026-01-02", sortOrder: 2 }),
        task({
          id: "parent-b",
          isLeaf: false,
          ownerKeys: [],
          durationDays: 2,
          predecessorDependencies: [{ predecessorTaskId: "parent-a", type: 1 }],
          sortOrder: 3,
        }),
        task({ id: "b-1", parentId: "parent-b", startDate: "", finishDate: "", durationDays: 1, sortOrder: 4 }),
        task({
          id: "b-2",
          parentId: "parent-b",
          startDate: "",
          finishDate: "",
          durationDays: 1,
          predecessorDependencies: [{ predecessorTaskId: "b-1", type: 1 }],
          sortOrder: 5,
        }),
      ],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-10",
      scopeTaskIds: ["b-1", "b-2"],
      modeOverride: "DURATION_FORWARD",
    });
    const candidate = formalCandidate(result);

    expect(candidate.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "b-1", startDate: "2026-01-03", finishDate: "2026-01-03" }),
      expect.objectContaining({ taskId: "b-2", startDate: "2026-01-04", finishDate: "2026-01-04" }),
    ]));
  });

  it("未确认正式工期时阻断自动排期", () => {
    const result = createResourceScheduleCandidates({
      tasks: [task({ durationDays: 0, finishDate: "" })],
      currentProjectId: "project-1",
      calendarMode: "CALENDAR_DAYS",
      expectedEndDate: "2026-01-10",
    });

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "MISSING_DURATION",
      severity: "ERROR",
      taskIds: ["task-1"],
    }));
    expect(result.candidates.every((candidate) => !candidate.applicable)).toBe(true);
  });
});
