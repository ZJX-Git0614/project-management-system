import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  userHasPermission: vi.fn(),
  projectFindUnique: vi.fn(),
  getProjectGanttBaselineOverview: vi.fn(),
  getGanttBaselinePermissions: vi.fn(),
  isProjectGanttManager: vi.fn(),
  publishProjectGanttBaseline: vi.fn(),
  refreshProjectGanttDerivedState: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  userHasPermission: mocks.userHasPermission,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: mocks.projectFindUnique },
  },
}));

vi.mock("@/lib/gantt-baseline-service", () => ({
  getProjectGanttBaselineOverview: mocks.getProjectGanttBaselineOverview,
  getGanttBaselinePermissions: mocks.getGanttBaselinePermissions,
  isProjectGanttManager: mocks.isProjectGanttManager,
  publishProjectGanttBaseline: mocks.publishProjectGanttBaseline,
  beginProjectGanttBaselineDraft: vi.fn(),
}));

vi.mock("@/lib/gantt-task-service", () => ({
  refreshProjectGanttDerivedState: mocks.refreshProjectGanttDerivedState,
}));

describe("POST /api/projects/:id/gantt-tasks/baseline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUser.mockResolvedValue({
      userId: "user-1",
      displayName: "项目经理",
      assignedRoleNames: ["项目经理"],
    });
    mocks.userHasPermission.mockResolvedValue(true);
    mocks.projectFindUnique.mockResolvedValue({
      id: "project-1",
      ganttRevision: 42,
      ganttBaselineVersion: 0,
      ganttBaselineState: "DRAFT",
      status: "IN_PROGRESS",
    });
    mocks.isProjectGanttManager.mockResolvedValue(true);
    mocks.getGanttBaselinePermissions.mockReturnValue({ canPublish: true });
    mocks.refreshProjectGanttDerivedState.mockResolvedValue(undefined);
    mocks.publishProjectGanttBaseline.mockResolvedValue({
      baseline: { id: "baseline-1", version: 1 },
      affectedTasks: 460,
      validation: {
        projectId: "project-1",
        taskCount: 460,
        valid: true,
        blockers: [],
        warnings: [{
          code: "CROSS_PROJECT_RESOURCE_CONFLICT",
          message: "跨项目资源需要协调",
          taskIds: ["task-1"],
          projectIds: ["project-2"],
        }],
      },
    });
  });

  it("publishes without reloading the complete baseline overview", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://localhost/api/projects/project-1/gantt-tasks/baseline", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "PUBLISH", reason: "正式发布" }),
    }), { params: Promise.resolve({ id: "project-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.refreshProjectGanttDerivedState).toHaveBeenCalledWith("project-1");
    expect(mocks.publishProjectGanttBaseline).toHaveBeenCalledWith({
      projectId: "project-1",
      actor: { userId: "user-1", displayName: "项目经理" },
      reason: "正式发布",
    });
    expect(mocks.getProjectGanttBaselineOverview).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        affectedTasks: 460,
        blockers: [],
        warnings: [expect.objectContaining({ code: "CROSS_PROJECT_RESOURCE_CONFLICT" })],
      },
    });
  });
});
