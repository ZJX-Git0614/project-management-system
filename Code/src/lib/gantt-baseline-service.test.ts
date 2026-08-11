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
    } as unknown as Parameters<typeof validateProjectGanttBaseline>[1];

    const result = await validateProjectGanttBaseline("project-1", client);

    expect(result.valid).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "INVALID_OWNER_ASSIGNMENT",
      taskIds: ["task-1"],
    }));
  });
});
