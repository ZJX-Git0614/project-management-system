import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userHasPermission: vi.fn(),
  resourceScheduleAnalysis: vi.fn(),
  prisma: {
    projectMember: { findFirst: vi.fn() },
    assistantActionRun: { create: vi.fn() },
  },
}));

vi.mock("@/lib/server-auth", () => ({ userHasPermission: mocks.userHasPermission }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/gantt-resource-service", () => ({
  RESOURCE_SCHEDULE_CANDIDATE_KINDS: ["MINIMAL_CHANGE", "EARLIEST_FINISH", "ON_TIME"],
  resourceScheduleAnalysis: mocks.resourceScheduleAnalysis,
  applyProjectResourceScheduleCandidate: vi.fn(),
}));

import { parseResourceOptimizationIntent, proposeAssistantAction } from "@/lib/assistant-actions";
import type { AssistantRuntimeConfig } from "@/lib/assistant-settings";
import type { AuthenticatedUser } from "@/lib/server-auth";

const user = {
  userId: "user-1",
  username: "admin",
  displayName: "管理员",
  assignedRoleNames: ["管理员"],
  assistantAccessMode: "REQUEST_APPROVAL",
} as AuthenticatedUser;

const runtime = {
  agentEnabled: true,
  agentEnabledToolIds: ["gantt.resource.optimize"],
  agentActionExpiryMinutes: 15,
} as AssistantRuntimeConfig;

describe("assistant resource optimization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userHasPermission.mockResolvedValue(true);
    mocks.resourceScheduleAnalysis.mockResolvedValue({
      context: { currentProject: { ganttRevision: 7 } },
      result: {
        snapshotHash: "snapshot-7",
        candidates: [{
          kind: "MINIMAL_CHANGE",
          title: "最少改动",
          applicable: true,
          changes: [{ taskId: "task-2", startDate: "2026-08-06", finishDate: "2026-08-07" }],
          remainingConflicts: [],
          metrics: { completionDate: "2026-08-20", totalShiftDays: 2 },
        }],
      },
    });
    mocks.prisma.assistantActionRun.create.mockImplementation(async ({ data }) => ({
      id: "action-resource",
      ...data,
      status: "PROPOSED",
      resultJson: "{}",
      createdAt: new Date(),
      updatedAt: new Date(),
      confirmedAt: null,
      executedAt: null,
      messageId: null,
      planId: null,
      planStepId: null,
    }));
  });

  it("distinguishes advice from an explicit apply instruction", () => {
    expect(parseResourceOptimizationIntent("分析一下资源冲突并给我优化建议")).toBeNull();
    expect(parseResourceOptimizationIntent("采用最少改动方案优化资源冲突")).toEqual({ candidateKind: "MINIMAL_CHANGE" });
    expect(parseResourceOptimizationIntent("执行按期优先的资源排期方案")).toEqual({ candidateKind: "ON_TIME" });
  });

  it("creates a version-bound confirmation proposal before writing WBS", async () => {
    const action = await proposeAssistantAction({
      message: "采用最少改动方案优化资源冲突",
      projectId: "project-1",
      user,
      runtime,
    });

    expect(action).toMatchObject({ toolId: "gantt.resource.optimize", riskLevel: "MEDIUM", status: "PROPOSED" });
    expect(mocks.prisma.assistantActionRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        toolId: "gantt.resource.optimize",
        argsJson: JSON.stringify({ candidateKind: "MINIMAL_CHANGE", revision: 7, snapshotHash: "snapshot-7" }),
      }),
    }));
  });
});
