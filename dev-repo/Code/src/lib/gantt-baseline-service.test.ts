import { describe, expect, it } from "vitest";

import {
  GANTT_BASELINE_STATES,
  getGanttBaselinePermissions,
  hasGanttTaskPlanningMutation,
  validateProjectGanttBaseline,
} from "@/lib/gantt-baseline-service";

describe("gantt baseline contracts", () => {
  it("keeps the three explicit baseline states stable", () => {
    expect(GANTT_BASELINE_STATES).toEqual({
      DRAFT: "DRAFT",
      PUBLISHED: "PUBLISHED",
      CHANGE_DRAFT: "CHANGE_DRAFT",
    });
  });

  it("does not perform database work during module import", () => {
    expect(typeof validateProjectGanttBaseline).toBe("function");
  });

  it("allows actual-only edits while identifying a planned task mutation", () => {
    const task = {
      taskName: "任务 A",
      taskDescription: "无",
      startDate: "2026-08-10",
      finishDate: "2026-08-12",
      startSlot: "AM",
      finishSlot: "PM",
      durationDays: 3,
      taskMode: "DURATION_FORWARD",
      parentBoundaryMode: "ROLLUP",
      schedulePriority: 500,
      userPriority: "MEDIUM",
      effortDriven: false,
      parallelizable: false,
      isMilestone: false,
      budgetItemId: null,
      predecessorTask: "",
      remark: "",
      ownerMemberId: null,
      ownerLinks: [],
      predecessorDependencies: [],
    };
    expect(hasGanttTaskPlanningMutation(task, { progress: 50, actualWorkHours: 7.5 })).toBe(false);
    expect(hasGanttTaskPlanningMutation(task, { durationDays: 3.5 })).toBe(true);
    expect(hasGanttTaskPlanningMutation(task, { taskMode: "FORWARD" })).toBe(false);
  });

  it("locks published planning changes but keeps actual updates available", () => {
    expect(getGanttBaselinePermissions({
      baselineState: "PUBLISHED",
      baselineVersion: 1,
      canMaintainDraft: true,
      canPublishBaseline: true,
      isProjectManager: true,
    })).toMatchObject({
      canEditPlanning: false,
      canEditActuals: true,
      canPrepareDraft: true,
      canPublish: false,
    });
  });

  it("only permits a project manager to change planning in a change draft", () => {
    const common = { baselineState: "CHANGE_DRAFT", baselineVersion: 1, canMaintainDraft: true, canPublishBaseline: true };
    expect(getGanttBaselinePermissions({ ...common, isProjectManager: false })).toMatchObject({
      canEditPlanning: false,
      canPublish: false,
      planningMutationBlocker: expect.stringContaining("仅项目经理"),
    });
    expect(getGanttBaselinePermissions({ ...common, isProjectManager: true })).toMatchObject({
      canEditPlanning: true,
      canPublish: true,
      planningMutationBlocker: null,
    });
  });

  it("requires the draft permission for an initial baseline draft", () => {
    expect(getGanttBaselinePermissions({
      baselineState: "DRAFT",
      baselineVersion: 0,
      canMaintainDraft: false,
      canPublishBaseline: true,
      isProjectManager: true,
    }).canPrepareDraft).toBe(false);
  });

  it("blocks baseline publication when a leaf task has multiple direct owners", async () => {
    const client = {
      project: {
        findUnique: async () => ({ ganttHardFinishDate: null }),
      },
      projectGanttTask: {
        findMany: async () => [{
          id: "task-1",
          parentId: null,
          taskCode: "Task1",
          taskName: "任务 A",
          startDate: "2026-08-10",
          finishDate: "2026-08-10",
          durationDays: 1,
          parentBoundaryMode: "ROLLUP",
          scheduleStatus: "SCHEDULED",
          ownerMemberId: null,
          ownerLinks: [{ projectMemberId: "member-1" }, { projectMemberId: "member-2" }],
        }],
      },
      projectGanttDependency: {
        findMany: async () => [],
      },
      projectMember: {
        findMany: async () => [],
      },
    } as unknown as Parameters<typeof validateProjectGanttBaseline>[1];

    const result = await validateProjectGanttBaseline("project-1", client);

    expect(result.valid).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "INVALID_OWNER_ASSIGNMENT",
      taskIds: ["task-1"],
    }));
  });

  it("does not treat the backward WBS anchor as a permanent baseline deadline", async () => {
    const client = {
      project: {
        findUnique: async () => ({
          ganttCalendarMode: "CALENDAR_DAYS",
          ganttHardFinishDate: "2026-08-10",
        }),
      },
      projectGanttTask: {
        findMany: async () => [{
          id: "task-1",
          parentId: null,
          taskCode: "Task1",
          taskName: "任务 A",
          startDate: "2026-08-11",
          finishDate: "2026-08-12",
          relativeStartOffsetDays: null,
          relativeFinishOffsetDays: null,
          durationDays: 2,
          durationMinutes: 960,
          estimatedWorkHours: 15,
          progress: 0,
          taskMode: "AUTO",
          effortDriven: false,
          parallelizable: false,
          sortOrder: 1,
          isMilestone: false,
          parentBoundaryMode: "ROLLUP",
          scheduleStatus: "SCHEDULED",
          ownerMemberId: null,
          ownerLinks: [],
        }],
      },
      projectGanttDependency: {
        findMany: async () => [],
      },
      projectMember: {
        findMany: async () => [],
      },
    } as unknown as Parameters<typeof validateProjectGanttBaseline>[1];

    const result = await validateProjectGanttBaseline("project-1", client);

    expect(result.valid).toBe(true);
    expect(result.blockers).not.toContainEqual(expect.objectContaining({
      message: expect.stringContaining("WBS 完成"),
    }));
  });

  it("blocks baseline publication when a single member exceeds capacity", async () => {
    const client = {
      project: {
        findUnique: async () => ({ ganttHardFinishDate: "", ganttCalendarMode: "CALENDAR_DAYS" }),
      },
      projectGanttTask: {
        findMany: async () => [
          {
            id: "task-1",
            parentId: null,
            taskCode: "Task1",
            taskName: "任务 A",
            startDate: "2026-08-10",
            finishDate: "2026-08-11",
            relativeStartOffsetDays: null,
            relativeFinishOffsetDays: null,
            durationDays: 2,
            durationMinutes: 960,
            estimatedWorkHours: 15,
            progress: 0,
            taskMode: "AUTO",
            effortDriven: false,
            parallelizable: false,
            sortOrder: 1,
            isMilestone: false,
            parentBoundaryMode: "ROLLUP",
            scheduleStatus: "SCHEDULED",
            ownerMemberId: "member-1",
            ownerLinks: [{ projectMemberId: "member-1", unitsPercent: 100, plannedWorkHours: 15 }],
          },
          {
            id: "task-2",
            parentId: null,
            taskCode: "Task2",
            taskName: "任务 B",
            startDate: "2026-08-10",
            finishDate: "2026-08-11",
            relativeStartOffsetDays: null,
            relativeFinishOffsetDays: null,
            durationDays: 2,
            durationMinutes: 960,
            estimatedWorkHours: 15,
            progress: 0,
            taskMode: "AUTO",
            effortDriven: false,
            parallelizable: false,
            sortOrder: 2,
            isMilestone: false,
            parentBoundaryMode: "ROLLUP",
            scheduleStatus: "SCHEDULED",
            ownerMemberId: "member-1",
            ownerLinks: [{ projectMemberId: "member-1", unitsPercent: 100, plannedWorkHours: 15 }],
          },
        ],
      },
      projectGanttDependency: {
        findMany: async () => [],
      },
      projectMember: {
        findMany: async () => [{
          id: "member-1",
          accountId: "account-1",
          personName: "王工",
          capacityHoursPerDay: 7.5,
          productivityRate: 1,
          maxConcurrentAssignments: 1,
        }],
      },
    } as unknown as Parameters<typeof validateProjectGanttBaseline>[1];

    const result = await validateProjectGanttBaseline("project-1", client);

    expect(result.valid).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "RESOURCE_CONFLICT",
      taskIds: expect.arrayContaining(["task-1", "task-2"]),
    }));
  });

  it("keeps shared-person conflicts from other projects as publication warnings", async () => {
    const currentTask = {
      id: "current-task",
      parentId: null,
      taskCode: "Task1",
      taskName: "当前项目任务",
      startDate: "2026-08-10",
      finishDate: "2026-08-10",
      relativeStartOffsetDays: null,
      relativeFinishOffsetDays: null,
      durationDays: 1,
      durationMinutes: 480,
      estimatedWorkHours: 7.5,
      progress: 0,
      taskMode: "AUTO",
      effortDriven: false,
      parallelizable: false,
      sortOrder: 1,
      isMilestone: false,
      parentBoundaryMode: "ROLLUP",
      scheduleStatus: "SCHEDULED",
      ownerMemberId: "member-current",
      ownerLinks: [{ projectMemberId: "member-current", unitsPercent: 100, plannedWorkHours: 7.5 }],
    };
    const otherTask = {
      ...currentTask,
      id: "other-task",
      projectId: "project-2",
      taskCode: "Task2",
      taskName: "其他项目任务",
      ownerMemberId: "member-other",
      ownerLinks: [{ projectMemberId: "member-other", unitsPercent: 100, plannedWorkHours: 7.5 }],
    };
    const client = {
      project: {
        findUnique: async () => ({ ganttHardFinishDate: "", ganttCalendarMode: "CALENDAR_DAYS" }),
        findMany: async () => [
          { id: "project-1", name: "当前项目" },
          { id: "project-2", name: "其他项目" },
        ],
      },
      projectGanttTask: {
        findMany: async (args: { where: { projectId: string | { in: string[] } } }) => (
          args.where.projectId === "project-1" ? [currentTask] : [otherTask]
        ),
      },
      projectGanttDependency: {
        findMany: async () => [],
      },
      projectMember: {
        findMany: async (args: { where: { projectId: string | { in: string[] } } }) => (
          args.where.projectId === "project-1"
            ? [{
              id: "member-current",
              projectId: "project-1",
              accountId: "account-shared",
              personName: "王工",
              capacityHoursPerDay: 7.5,
              productivityRate: 1,
              maxConcurrentAssignments: 1,
            }]
            : [{
              id: "member-other",
              projectId: "project-2",
              accountId: "account-shared",
              personName: "王工",
              capacityHoursPerDay: 7.5,
              productivityRate: 1,
              maxConcurrentAssignments: 1,
            }]
        ),
      },
    } as unknown as Parameters<typeof validateProjectGanttBaseline>[1];

    const result = await validateProjectGanttBaseline("project-1", client);

    expect(result.valid).toBe(true);
    expect(result.blockers).not.toContainEqual(expect.objectContaining({ code: "RESOURCE_CONFLICT" }));
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "CROSS_PROJECT_RESOURCE_CONFLICT",
      taskIds: ["current-task"],
      projectIds: ["project-2"],
    }));
  });
});
