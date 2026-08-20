import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPROVAL_BUSINESS_TYPES,
  CONFIGURABLE_APPROVAL_WORKFLOWS,
  validateApprovalWorkflowDraft,
} from "@/lib/approval-workflow";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  userHasPermission: vi.fn(),
  startApprovalWorkflow: vi.fn(),
  serializeApprovalInstance: vi.fn(),
  getProjectGanttCalendarMode: vi.fn(),
  convertFixedSuccessorsBlockedByActualCompletion: vi.fn(),
  refreshProjectGanttDerivedState: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  userHasPermission: mocks.userHasPermission,
}));

vi.mock("@/lib/approval-workflow-server", () => ({
  startApprovalWorkflow: mocks.startApprovalWorkflow,
  serializeApprovalInstance: mocks.serializeApprovalInstance,
}));

vi.mock("@/lib/gantt-task-service", () => ({
  getProjectGanttCalendarMode: mocks.getProjectGanttCalendarMode,
  convertFixedSuccessorsBlockedByActualCompletion: mocks.convertFixedSuccessorsBlockedByActualCompletion,
  refreshProjectGanttDerivedState: mocks.refreshProjectGanttDerivedState,
}));

const user = {
  userId: "account-owner",
  displayName: "负责人",
  assignedRoleNames: ["项目成员"],
  assistantAccessMode: "REQUEST_APPROVAL",
};

describe("POST /api/projects/:id/gantt-tasks/:taskId/progress-submissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUser.mockResolvedValue(user);
    mocks.userHasPermission.mockResolvedValue(true);
    mocks.startApprovalWorkflow.mockResolvedValue({
      id: "approval-1",
      createdAt: new Date("2026-08-17T00:00:00.000Z"),
      updatedAt: new Date("2026-08-17T00:00:00.000Z"),
      requestedAt: new Date("2026-08-17T00:00:00.000Z"),
      completedAt: null,
    });
    mocks.serializeApprovalInstance.mockReturnValue({ id: "approval-1" });
  });

  it("starts a WBS progress approval without mutating the task directly", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://localhost/api/projects/project-1/gantt-tasks/task-1/progress-submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskCode: "Task1.1",
        taskName: "现场安装",
        progress: 80,
        actualStartDate: "2026-08-10",
        actualWorkHours: 12.5,
      }),
    }), { params: Promise.resolve({ id: "project-1", taskId: "task-1" }) });

    expect(response.status).toBe(202);
    expect(mocks.startApprovalWorkflow).toHaveBeenCalledWith({
      projectId: "project-1",
      businessType: APPROVAL_BUSINESS_TYPES.WBS_TASK_PROGRESS_SUBMISSION,
      businessId: "project-1:wbs-task-progress:task-1",
      requester: user,
      payload: {
        taskId: "task-1",
        taskCode: "Task1.1",
        taskName: "现场安装",
        progress: 80,
        actualStartDate: "2026-08-10",
        actualEndDate: "",
        actualWorkHours: 12.5,
      },
    });
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { approvalRequired: true, approvalInstance: { id: "approval-1" } },
    });
  });

  it("requires the existing WBS view permission", async () => {
    mocks.userHasPermission.mockResolvedValue(false);
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://localhost/api/projects/project-1/gantt-tasks/task-1/progress-submissions", {
      method: "POST",
      body: JSON.stringify({ progress: 50 }),
    }), { params: Promise.resolve({ id: "project-1", taskId: "task-1" }) });

    expect(response.status).toBe(403);
    expect(mocks.startApprovalWorkflow).not.toHaveBeenCalled();
  });
});

describe("WBS task progress approval business handler", () => {
  const createDb = () => ({
    projectGanttTask: {
      findFirst: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    project: { findUnique: vi.fn(), update: vi.fn() },
    operationHistory: { create: vi.fn() },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T08:00:00.000Z"));
    mocks.getProjectGanttCalendarMode.mockResolvedValue("CALENDAR_DAYS");
    mocks.convertFixedSuccessorsBlockedByActualCompletion.mockResolvedValue([{ id: "task-2" }]);
    mocks.refreshProjectGanttDerivedState.mockResolvedValue(undefined);
  });

  it("exposes the business type as a configurable approval workflow", async () => {
    const { listApprovalBusinessCapabilities } = await import("@/lib/approval-business-registry");
    const workflow = CONFIGURABLE_APPROVAL_WORKFLOWS.find(
      (item) => item.businessType === APPROVAL_BUSINESS_TYPES.WBS_TASK_PROGRESS_SUBMISSION,
    );

    expect(workflow).toMatchObject({
      businessType: APPROVAL_BUSINESS_TYPES.WBS_TASK_PROGRESS_SUBMISSION,
      completionHandlerKey: "APPLY_WBS_TASK_PROGRESS_SUBMISSION",
    });
    expect(validateApprovalWorkflowDraft(workflow!)).toEqual([]);
    expect(listApprovalBusinessCapabilities()).toContainEqual({
      businessType: APPROVAL_BUSINESS_TYPES.WBS_TASK_PROGRESS_SUBMISSION,
      handlerKey: "APPLY_WBS_TASK_PROGRESS_SUBMISSION",
    });
  });

  it("rejects progress submissions from non-leaf or non-owner tasks", async () => {
    const { getApprovalBusinessHandler } = await import("@/lib/approval-business-registry");
    const handler = getApprovalBusinessHandler(APPROVAL_BUSINESS_TYPES.WBS_TASK_PROGRESS_SUBMISSION);
    const db = createDb();
    db.project.findUnique.mockResolvedValue({ status: "IN_PROGRESS" });
    db.projectGanttTask.findFirst.mockResolvedValue({
      id: "task-1",
      progress: 20,
      ownerMember: null,
      ownerLinks: [{ projectMember: { accountId: "account-owner" } }],
    });
    db.projectGanttTask.count.mockResolvedValue(1);

    await expect(handler.validateStart(db as never, {
      projectId: "project-1",
      businessId: "project-1:wbs-task-progress:task-1",
      payload: { taskId: "task-1", progress: 80 },
      requester: user,
    })).rejects.toThrow("只有末级任务可以提交进度审批");

    db.projectGanttTask.count.mockResolvedValue(0);
    await expect(handler.validateStart(db as never, {
      projectId: "project-1",
      businessId: "project-1:wbs-task-progress:task-1",
      payload: { taskId: "task-1", progress: 80 },
      requester: { ...user, userId: "other-account" },
    })).rejects.toThrow("只有末级任务的直接负责人可以提交本人任务进度");
  });

  it("applies approved progress facts and refreshes derived WBS state", async () => {
    const { getApprovalBusinessHandler } = await import("@/lib/approval-business-registry");
    const handler = getApprovalBusinessHandler(APPROVAL_BUSINESS_TYPES.WBS_TASK_PROGRESS_SUBMISSION);
    const db = createDb();
    db.project.findUnique.mockResolvedValue({ status: "IN_PROGRESS" });
    db.projectGanttTask.findFirst.mockResolvedValue({
      id: "task-1",
      taskCode: "Task1.1",
      taskName: "现场安装",
      progress: 40,
      actualEndDate: "",
      ownerMember: null,
      ownerLinks: [{ projectMember: { accountId: "account-owner" } }],
    });
    db.projectGanttTask.count.mockResolvedValue(0);
    db.projectGanttTask.updateMany.mockResolvedValue({ count: 1 });
    db.project.update.mockResolvedValue({});
    db.operationHistory.create.mockResolvedValue({});

    const result = await handler.apply(db as never, {
      id: "approval-1",
      projectId: "project-1",
      requesterAccountId: "account-owner",
      requesterName: "负责人",
      payload: {
        taskId: "task-1",
        progress: 100,
        actualStartDate: "2026-08-10",
        actualWorkHours: 18.256,
      },
    } as never);

    expect(db.projectGanttTask.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", projectId: "project-1" },
      data: {
        progress: 100,
        actualStartDate: "2026-08-10",
        actualEndDate: "2026-08-17",
        actualWorkHours: 18.26,
      },
    });
    expect(mocks.convertFixedSuccessorsBlockedByActualCompletion).toHaveBeenCalledWith(
      "project-1",
      ["task-1"],
      "CALENDAR_DAYS",
      db,
    );
    expect(mocks.refreshProjectGanttDerivedState).toHaveBeenCalledWith("project-1", "CALENDAR_DAYS", db);
    expect(result).toMatchObject({
      taskId: "task-1",
      progress: 100,
      actualEndDate: "2026-08-17",
      releasedSuccessorTaskIds: ["task-2"],
    });
  });

  it("uses the Beijing calendar date when completion is approved around UTC midnight", async () => {
    vi.setSystemTime(new Date("2026-08-16T16:30:00.000Z"));
    const { getApprovalBusinessHandler } = await import("@/lib/approval-business-registry");
    const handler = getApprovalBusinessHandler(APPROVAL_BUSINESS_TYPES.WBS_TASK_PROGRESS_SUBMISSION);
    const db = createDb();
    db.project.findUnique.mockResolvedValue({ status: "IN_PROGRESS" });
    db.projectGanttTask.findFirst.mockResolvedValue({
      id: "task-1",
      taskCode: "Task1.1",
      taskName: "现场安装",
      progress: 40,
      actualEndDate: "",
      ownerMember: null,
      ownerLinks: [{ projectMember: { accountId: "account-owner" } }],
    });
    db.projectGanttTask.count.mockResolvedValue(0);
    db.projectGanttTask.updateMany.mockResolvedValue({ count: 1 });
    db.project.update.mockResolvedValue({});
    db.operationHistory.create.mockResolvedValue({});

    await handler.apply(db as never, {
      id: "approval-1",
      projectId: "project-1",
      requesterAccountId: "account-owner",
      requesterName: "负责人",
      payload: { taskId: "task-1", progress: 100, actualWorkHours: 8 },
    } as never);

    expect(db.projectGanttTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actualEndDate: "2026-08-17" }),
    }));
  });
});
