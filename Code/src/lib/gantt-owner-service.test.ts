import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyGanttOwnerChange,
  replaceGanttOwnerMember,
  resolveEffectiveGanttOwnerMemberId,
  synchronizeGanttOwnerHierarchy,
} from "@/lib/gantt-owner-service";

const mocks = vi.hoisted(() => ({
  taskFindMany: vi.fn(),
  taskUpdate: vi.fn(),
  memberFindMany: vi.fn(),
  weeklyFindMany: vi.fn(),
  weeklyUpdate: vi.fn(),
  weeklyUpdateMany: vi.fn(),
  riskFindMany: vi.fn(),
  riskUpdate: vi.fn(),
  riskUpdateMany: vi.fn(),
}));

const tx = {
  projectGanttTask: {
    findMany: mocks.taskFindMany,
    update: mocks.taskUpdate,
  },
  projectMember: { findMany: mocks.memberFindMany },
  weeklyItem: { findMany: mocks.weeklyFindMany, update: mocks.weeklyUpdate, updateMany: mocks.weeklyUpdateMany },
  riskRegisterItem: { findMany: mocks.riskFindMany, update: mocks.riskUpdate, updateMany: mocks.riskUpdateMany },
};

describe("gantt owner service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.taskUpdate.mockResolvedValue({});
    mocks.weeklyFindMany.mockResolvedValue([]);
    mocks.weeklyUpdate.mockResolvedValue({});
    mocks.weeklyUpdateMany.mockResolvedValue({ count: 0 });
    mocks.riskFindMany.mockResolvedValue([]);
    mocks.riskUpdate.mockResolvedValue({});
    mocks.riskUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("normalizes duplicate role memberships to one stable parent member id", async () => {
    mocks.taskFindMany.mockResolvedValue([
      { id: "root", parentId: null, ownerMemberId: null },
      { id: "child-a", parentId: "root", ownerMemberId: "member-z" },
      { id: "child-b", parentId: "root", ownerMemberId: "member-a" },
    ]);
    mocks.memberFindMany.mockResolvedValue([
      { id: "member-z", accountId: "account-1", personName: "张三" },
      { id: "member-a", accountId: "account-1", personName: "张三" },
    ]);

    await expect(synchronizeGanttOwnerHierarchy({
      tx: tx as never,
      projectId: "project-1",
    })).resolves.toEqual({ updatedTaskIds: ["root"] });
    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: "root" },
      data: { ownerMemberId: "member-a", resourceNotBeforeDate: "" },
    });
  });

  it("resolves the effective parent owner for child insertion", async () => {
    mocks.taskFindMany.mockResolvedValue([
      { id: "root", parentId: null, ownerMemberId: null },
      { id: "child", parentId: "root", ownerMemberId: "member-z" },
    ]);
    mocks.memberFindMany.mockResolvedValue([
      { id: "member-z", accountId: "account-1", personName: "张三" },
      { id: "member-a", accountId: "account-1", personName: "张三" },
    ]);

    await expect(resolveEffectiveGanttOwnerMemberId({
      tx: tx as never,
      projectId: "project-1",
      taskId: "root",
    })).resolves.toBe("member-a");
  });

  it("clears the entire subtree when a parent is explicitly set to unassigned", async () => {
    mocks.taskFindMany.mockResolvedValue([
      { id: "root", parentId: null, ownerMemberId: "member-a" },
      { id: "child", parentId: "root", ownerMemberId: "member-a" },
      { id: "leaf", parentId: "child", ownerMemberId: "member-a" },
    ]);
    mocks.memberFindMany.mockResolvedValue([
      { id: "member-a", accountId: "account-1", personName: "张三" },
    ]);

    const result = await applyGanttOwnerChange({
      tx: tx as never,
      projectId: "project-1",
      taskId: "root",
      nextOwnerMemberId: null,
      allowBranchReassignment: true,
    });

    expect(result.updatedTaskIds).toEqual(["root", "child", "leaf"]);
    expect(mocks.taskUpdate.mock.calls.map(([input]) => input)).toEqual([
      { where: { id: "root" }, data: { ownerMemberId: null, resourceNotBeforeDate: "" } },
      { where: { id: "child" }, data: { ownerMemberId: null, resourceNotBeforeDate: "" } },
      { where: { id: "leaf" }, data: { ownerMemberId: null, resourceNotBeforeDate: "" } },
    ]);
  });

  it("keeps a parent rollup read-only after any descendant is assigned", async () => {
    mocks.taskFindMany.mockResolvedValue([
      { id: "root", parentId: null, ownerMemberId: "member-a" },
      { id: "child", parentId: "root", ownerMemberId: "member-a" },
    ]);
    mocks.memberFindMany.mockResolvedValue([
      { id: "member-a", accountId: "account-1", personName: "张三" },
      { id: "member-b", accountId: "account-2", personName: "李四" },
    ]);

    await expect(applyGanttOwnerChange({
      tx: tx as never,
      projectId: "project-1",
      taskId: "root",
      nextOwnerMemberId: "member-b",
    })).rejects.toThrow("只读");
    expect(mocks.taskUpdate).not.toHaveBeenCalled();
  });

  it("does not retain a soon-to-be-deleted role membership as the canonical parent owner", async () => {
    mocks.taskFindMany.mockResolvedValue([
      { id: "root", parentId: null, ownerMemberId: "member-a" },
      { id: "child", parentId: "root", ownerMemberId: "member-z" },
    ]);
    mocks.memberFindMany.mockResolvedValue([
      { id: "member-a", accountId: "account-1", personName: "张三" },
      { id: "member-z", accountId: "account-1", personName: "张三" },
    ]);

    await replaceGanttOwnerMember({
      tx: tx as never,
      projectId: "project-1",
      removedMemberId: "member-a",
      removedPersonName: "张三",
      replacementMemberId: null,
      replacementPersonName: null,
    });

    expect(mocks.taskUpdate).toHaveBeenCalledWith({
      where: { id: "root" },
      data: { ownerMemberId: "member-z", resourceNotBeforeDate: "" },
    });
  });
});
