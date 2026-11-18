import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadAssistantRuntimeConfig: vi.fn(),
  prisma: {
    assistantChatMessage: { deleteMany: vi.fn() },
    assistantActionRun: { deleteMany: vi.fn() },
    assistantPlanRun: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/assistant-settings", () => ({
  loadAssistantRuntimeConfig: mocks.loadAssistantRuntimeConfig,
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

describe("cleanupAssistantHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadAssistantRuntimeConfig.mockResolvedValue({ historyRetentionDays: 30 });
    mocks.prisma.assistantChatMessage.deleteMany.mockReturnValue("messages");
    mocks.prisma.assistantActionRun.deleteMany.mockReturnValue("actions");
    mocks.prisma.assistantPlanRun.deleteMany.mockReturnValue("plans");
    mocks.prisma.$transaction.mockResolvedValue([
      { count: 2 },
      { count: 3 },
      { count: 1 },
    ]);
  });

  it("deletes all assistant records older than the configured cutoff in one transaction", async () => {
    const { cleanupAssistantHistory } = await import("./cleanup-assistant-history");
    const now = new Date("2026-09-01T00:00:00.000Z");

    const result = await cleanupAssistantHistory({ now });

    expect(result).toEqual({
      cutoff: new Date("2026-08-02T00:00:00.000Z"),
      deleted: { messages: 2, actions: 3, plans: 1 },
    });
    expect(mocks.loadAssistantRuntimeConfig).toHaveBeenCalledOnce();
    expect(mocks.prisma.$transaction).toHaveBeenCalledOnce();
    expect(mocks.prisma.assistantChatMessage.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2026-08-02T00:00:00.000Z") } },
    });
    expect(mocks.prisma.assistantActionRun.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2026-08-02T00:00:00.000Z") } },
    });
    expect(mocks.prisma.assistantPlanRun.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2026-08-02T00:00:00.000Z") } },
    });
  });

  it("accepts an explicit retention period for scheduled or isolated execution", async () => {
    const { cleanupAssistantHistory } = await import("./cleanup-assistant-history");
    const now = new Date("2026-09-01T12:00:00.000Z");

    const result = await cleanupAssistantHistory({ now, historyRetentionDays: 1 });

    expect(result.cutoff).toEqual(new Date("2026-08-31T12:00:00.000Z"));
    expect(mocks.loadAssistantRuntimeConfig).not.toHaveBeenCalled();
  });
});
