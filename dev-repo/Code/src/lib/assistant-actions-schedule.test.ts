import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userHasPermission: vi.fn(),
  prisma: {
    projectMember: { findFirst: vi.fn() },
    assistantAttachment: { findFirst: vi.fn(), findMany: vi.fn() },
    assistantActionRun: { create: vi.fn() },
  },
}));

vi.mock("@/lib/server-auth", () => ({ userHasPermission: mocks.userHasPermission }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

import { proposeAssistantAction } from "@/lib/assistant-actions";
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
  agentEnabledToolIds: ["schedule.import.preview", "schedule.compare.file", "schedule.convert.file", "schedule.merge.files", "document.revision.generate"],
  agentActionExpiryMinutes: 15,
} as AssistantRuntimeConfig;

describe("schedule assistant actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userHasPermission.mockResolvedValue(true);
  });

  it("proposes a low-risk conversion for one ready MPP attachment", async () => {
    mocks.prisma.assistantAttachment.findFirst.mockResolvedValue({ id: "attachment-1", originalName: "项目计划.mpp" });
    mocks.prisma.assistantActionRun.create.mockImplementation(async ({ data }) => ({
      id: "action-1",
      ...data,
      status: "PROPOSED",
      resultJson: "{}",
      errorMessage: "",
      createdAt: new Date("2026-07-29T00:00:00.000Z"),
      updatedAt: new Date("2026-07-29T00:00:00.000Z"),
      confirmedAt: null,
      executedAt: null,
      messageId: null,
    }));

    const action = await proposeAssistantAction({
      message: "把这个 MPP 按系统甘特任务格式输出文件",
      projectId: "project-1",
      user,
      runtime,
      attachmentIds: ["attachment-1"],
    });

    expect(action).toMatchObject({
      toolId: "schedule.convert.file",
      riskLevel: "LOW",
      status: "PROPOSED",
      title: "转换进度计划文件",
    });
    expect(mocks.prisma.assistantActionRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        toolId: "schedule.convert.file",
        argsJson: JSON.stringify({ attachmentId: "attachment-1" }),
      }),
    }));
  });

  it("does not invent a conversion action before a source attachment is uploaded", async () => {
    await expect(proposeAssistantAction({
      message: "我给你一个mpp文件，你能帮我按照系统的甘特任务格式输出文件吗",
      projectId: "project-1",
      user,
      runtime,
      attachmentIds: [],
    })).resolves.toBeNull();
    expect(mocks.prisma.assistantActionRun.create).not.toHaveBeenCalled();
  });

  it("proposes a non-mutating comparison against the current project plan", async () => {
    mocks.prisma.assistantAttachment.findFirst.mockResolvedValue({ id: "attachment-1", originalName: "本周计划.mpp" });
    mocks.prisma.assistantActionRun.create.mockImplementation(async ({ data }) => ({
      id: "action-compare",
      ...data,
      status: "PROPOSED",
      resultJson: "{}",
      createdAt: new Date(),
      updatedAt: new Date(),
      confirmedAt: null,
      executedAt: null,
    }));

    const action = await proposeAssistantAction({
      message: "对比附件计划与当前进度，检查差异、冲突和干涉任务",
      projectId: "project-1",
      user,
      runtime,
      attachmentIds: ["attachment-1"],
    });

    expect(action).toMatchObject({ toolId: "schedule.compare.file", riskLevel: "LOW" });
    expect(mocks.prisma.assistantActionRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        argsJson: expect.stringContaining('"attachmentId":"attachment-1"'),
      }),
    }));
  });

  it("routes an explicit WBS import request to a non-mutating preview first", async () => {
    mocks.prisma.assistantAttachment.findFirst.mockResolvedValue({ id: "attachment-import", originalName: "实施排期.xlsx" });
    mocks.prisma.assistantActionRun.create.mockImplementation(async ({ data }) => ({
      id: "action-import-preview",
      ...data,
      status: "PROPOSED",
      resultJson: "{}",
      createdAt: new Date(),
      updatedAt: new Date(),
      confirmedAt: null,
      executedAt: null,
    }));

    const action = await proposeAssistantAction({
      message: "把附件排期导入当前项目 WBS",
      projectId: "project-1",
      user,
      runtime,
      attachmentIds: ["attachment-import"],
    });

    expect(action).toMatchObject({ toolId: "schedule.import.preview", riskLevel: "LOW", title: "生成 WBS 导入预览" });
    expect(mocks.prisma.assistantActionRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        toolId: "schedule.import.preview",
        argsJson: expect.stringContaining('"hierarchyMode":"AUTO"'),
      }),
    }));
  });

  it("preserves an explicit flat-import instruction in the preview proposal", async () => {
    mocks.prisma.assistantAttachment.findFirst.mockResolvedValue({ id: "attachment-flat", originalName: "实施排期.csv" });
    mocks.prisma.assistantActionRun.create.mockImplementation(async ({ data }) => ({
      id: "action-flat-preview",
      ...data,
      status: "PROPOSED",
      resultJson: "{}",
      createdAt: new Date(),
      updatedAt: new Date(),
      confirmedAt: null,
      executedAt: null,
    }));

    await proposeAssistantAction({
      message: "扁平导入这个排期，不要创建分类节点",
      projectId: "project-1",
      user,
      runtime,
      attachmentIds: ["attachment-flat"],
    });

    expect(mocks.prisma.assistantActionRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ argsJson: expect.stringContaining('"hierarchyMode":"FLAT"') }),
    }));
  });

  it("routes an explicit DOCX schedule import request to preview instead of document rewriting", async () => {
    mocks.prisma.assistantAttachment.findFirst.mockResolvedValue({ id: "attachment-docx-plan", originalName: "实施排期.docx" });
    mocks.prisma.assistantActionRun.create.mockImplementation(async ({ data }) => ({
      id: "action-docx-preview",
      ...data,
      status: "PROPOSED",
      resultJson: "{}",
      createdAt: new Date(),
      updatedAt: new Date(),
      confirmedAt: null,
      executedAt: null,
    }));

    const action = await proposeAssistantAction({
      message: "把附件里的排期导入当前项目 WBS",
      projectId: "project-1",
      user,
      runtime,
      attachmentIds: ["attachment-docx-plan"],
    });

    expect(action).toMatchObject({ toolId: "schedule.import.preview", riskLevel: "LOW" });
  });

  it("proposes an end-to-end document revision artifact", async () => {
    mocks.prisma.assistantAttachment.findFirst.mockResolvedValue({ id: "attachment-doc", originalName: "需求说明.docx" });
    mocks.prisma.assistantActionRun.create.mockImplementation(async ({ data }) => ({
      id: "action-document",
      ...data,
      status: "PROPOSED",
      resultJson: "{}",
      createdAt: new Date(),
      updatedAt: new Date(),
      confirmedAt: null,
      executedAt: null,
    }));

    const action = await proposeAssistantAction({
      message: "把这份逻辑不清晰的文档梳理清楚并细化内容",
      projectId: "project-1",
      user,
      runtime,
      attachmentIds: ["attachment-doc"],
    });

    expect(action).toMatchObject({ toolId: "document.revision.generate", status: "PROPOSED" });
  });
});
