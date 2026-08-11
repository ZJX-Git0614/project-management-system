import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    projectGanttTask: {
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    project: {
      update: vi.fn(),
    },
  };
  return {
    getAuthenticatedUser: vi.fn(),
    userHasPermission: vi.fn(),
    projectFindUnique: vi.fn(),
    taskFindFirst: vi.fn(),
    taskFindMany: vi.fn(),
    memberFindFirst: vi.fn(),
    transaction: vi.fn(),
    getProjectGanttCalendarMode: vi.fn(),
    getOrderedGanttTasks: vi.fn(),
    parseGanttDependencyInput: vi.fn(),
    recalculateProjectGanttSchedule: vi.fn(),
    renumberProjectGanttTaskCodes: vi.fn(),
    replaceGanttTaskDependencies: vi.fn(),
    serializeGanttTaskList: vi.fn(),
    resolveEffectiveGanttOwnerMemberIds: vi.fn(),
    synchronizeGanttOwnerHierarchy: vi.fn(),
    tx,
  };
});

vi.mock("@/lib/server-auth", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  userHasPermission: mocks.userHasPermission,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: mocks.projectFindUnique },
    projectGanttTask: {
      findFirst: mocks.taskFindFirst,
      findMany: mocks.taskFindMany,
    },
    projectMember: { findFirst: mocks.memberFindFirst },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/gantt-task-service", () => ({
  getProjectGanttCalendarMode: mocks.getProjectGanttCalendarMode,
  getOrderedGanttTasks: mocks.getOrderedGanttTasks,
  parseGanttDependencyInput: mocks.parseGanttDependencyInput,
  recalculateProjectGanttSchedule: mocks.recalculateProjectGanttSchedule,
  renumberProjectGanttTaskCodes: mocks.renumberProjectGanttTaskCodes,
  replaceGanttTaskDependencies: mocks.replaceGanttTaskDependencies,
  serializeGanttTaskList: mocks.serializeGanttTaskList,
}));

vi.mock("@/lib/gantt-owner-service", () => ({
  resolveEffectiveGanttOwnerMemberIds: mocks.resolveEffectiveGanttOwnerMemberIds,
  synchronizeGanttOwnerHierarchy: mocks.synchronizeGanttOwnerHierarchy,
}));

describe("POST /api/projects/:id/gantt-tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUser.mockResolvedValue({
      userId: "user-1",
      displayName: "管理员",
      assignedRoleNames: ["管理员"],
    });
    mocks.userHasPermission.mockResolvedValue(true);
    mocks.projectFindUnique.mockResolvedValue({ id: "project-1", status: "IN_PROGRESS" });
    mocks.taskFindFirst.mockResolvedValue({ id: "parent-1", taskCategory: "设计", taskName: "设计" });
    mocks.taskFindMany.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (callback) => callback(mocks.tx));
    mocks.tx.projectGanttTask.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.projectGanttTask.create.mockResolvedValue({ id: "created-1" });
    mocks.tx.project.update.mockResolvedValue({});
    mocks.getProjectGanttCalendarMode.mockResolvedValue("NATURAL_DAY");
    mocks.parseGanttDependencyInput.mockReturnValue([]);
    mocks.resolveEffectiveGanttOwnerMemberIds.mockResolvedValue(["member-parent", "member-parent-2"]);
    mocks.synchronizeGanttOwnerHierarchy.mockResolvedValue({ updatedTaskIds: [] });
    mocks.getOrderedGanttTasks.mockResolvedValue([{ id: "created-1" }]);
    mocks.serializeGanttTaskList.mockReturnValue([{ id: "created-1", ownerMemberId: "member-parent" }]);
  });

  it("does not copy multiple aggregated parent owners onto a new leaf task", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://localhost/api/projects/project-1/gantt-tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskName: "子任务",
        startDate: "2026-08-04",
        durationDays: 1,
        parentId: "parent-1",
      }),
    }), { params: Promise.resolve({ id: "project-1" }) });

    expect(response.status).toBe(201);
    expect(mocks.resolveEffectiveGanttOwnerMemberIds).toHaveBeenCalledWith({
      tx: mocks.tx,
      projectId: "project-1",
      taskId: "parent-1",
    });
    expect(mocks.tx.projectGanttTask.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        parentId: "parent-1",
        ownerMemberId: null,
        ownerLinks: undefined,
      }),
    }));
    expect(mocks.synchronizeGanttOwnerHierarchy).toHaveBeenCalledWith({
      tx: mocks.tx,
      projectId: "project-1",
    });
  });
});
