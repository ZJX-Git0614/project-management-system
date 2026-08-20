import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureMutableProject: vi.fn(),
  getAuthenticatedUser: vi.fn(),
  userHasPermission: vi.fn(),
  getGanttPlanMutationBlockReasonForActor: vi.fn(),
  clearProjectGanttTaskDurations: vi.fn(),
}));

vi.mock("@/lib/api-utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-utils")>("@/lib/api-utils");
  return { ...actual, ensureMutableProject: mocks.ensureMutableProject };
});
vi.mock("@/lib/server-auth", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  userHasPermission: mocks.userHasPermission,
}));
vi.mock("@/lib/gantt-baseline-service", () => ({
  getGanttPlanMutationBlockReasonForActor: mocks.getGanttPlanMutationBlockReasonForActor,
}));
vi.mock("@/lib/gantt-task-service", () => ({
  clearProjectGanttTaskDurations: mocks.clearProjectGanttTaskDurations,
}));

describe("POST /api/projects/:id/gantt-tasks/:taskId/clear-duration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUser.mockResolvedValue({
      userId: "account-1",
      displayName: "项目经理",
      assignedRoleNames: ["项目经理"],
    });
    mocks.userHasPermission.mockResolvedValue(true);
    mocks.ensureMutableProject.mockResolvedValue(null);
    mocks.getGanttPlanMutationBlockReasonForActor.mockResolvedValue(null);
    mocks.clearProjectGanttTaskDurations.mockResolvedValue({
      affectedTaskIds: ["task-2", "task-3"],
      affectedCount: 2,
      isParentTask: true,
      tasks: [],
    });
  });

  it("clears descendant durations through the task service", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://localhost/api/projects/project-1/gantt-tasks/task-1/clear-duration", {
      method: "POST",
    }), { params: Promise.resolve({ id: "project-1", taskId: "task-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.clearProjectGanttTaskDurations).toHaveBeenCalledWith({
      projectId: "project-1",
      taskId: "task-1",
      operator: "项目经理",
    });
  });

  it("blocks the mutation when the baseline is locked", async () => {
    mocks.getGanttPlanMutationBlockReasonForActor.mockResolvedValue("当前基线已发布");
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://localhost/api/projects/project-1/gantt-tasks/task-1/clear-duration", {
      method: "POST",
    }), { params: Promise.resolve({ id: "project-1", taskId: "task-1" }) });

    expect(response.status).toBe(409);
    expect(mocks.clearProjectGanttTaskDurations).not.toHaveBeenCalled();
  });
});
