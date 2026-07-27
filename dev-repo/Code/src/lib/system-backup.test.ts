import { describe, expect, it } from "vitest";

import { isAutomaticBackupDue, postgresToolConnectionUrl } from "@/lib/system-backup";

const settings = {
  automaticBackupEnabled: true,
  lastAutomaticBackupAt: new Date("2026-07-24T00:00:00.000Z"),
} as Parameters<typeof isAutomaticBackupDue>[0];

describe("system backup schedule", () => {
  it("runs automatic backup every six hours", () => {
    expect(isAutomaticBackupDue(settings, new Date("2026-07-24T05:59:59.000Z"))).toBe(false);
    expect(isAutomaticBackupDue(settings, new Date("2026-07-24T06:00:00.000Z"))).toBe(true);
  });

  it("runs immediately when automatic backup has never completed", () => {
    expect(isAutomaticBackupDue({ ...settings, lastAutomaticBackupAt: null })).toBe(true);
    expect(isAutomaticBackupDue({ ...settings, automaticBackupEnabled: false })).toBe(false);
  });

  it("removes Prisma-only schema parameters for PostgreSQL command-line tools", () => {
    expect(postgresToolConnectionUrl("postgresql://user:pass@localhost:5432/pms?schema=public&sslmode=require"))
      .toBe("postgresql://user:pass@localhost:5432/pms?sslmode=require");
  });
});
