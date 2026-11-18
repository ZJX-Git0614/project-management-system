import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
  },
}));

describe("runWithMaintenanceLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback) => callback({ $queryRaw: mocks.queryRaw }));
  });

  it("runs the job only when the database lease is acquired", async () => {
    mocks.queryRaw.mockResolvedValue([{ locked: true }]);
    const job = vi.fn().mockResolvedValue("done");
    const { runWithMaintenanceLock } = await import("./maintenance-lock");

    const result = await runWithMaintenanceLock("assistant-history", job);

    expect(result).toEqual({ acquired: true, result: "done" });
    expect(job).toHaveBeenCalledOnce();
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 10_000, timeout: 900_000 });
  });

  it("skips a job when another worker owns the lease", async () => {
    mocks.queryRaw.mockResolvedValue([{ locked: false }]);
    const job = vi.fn();
    const { runWithMaintenanceLock } = await import("./maintenance-lock");

    const result = await runWithMaintenanceLock("assistant-history", job);

    expect(result).toEqual({ acquired: false });
    expect(job).not.toHaveBeenCalled();
  });
});
