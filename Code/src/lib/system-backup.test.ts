import { describe, expect, it } from "vitest";

import {
  databaseRestoreCommandPlan,
  isAutomaticBackupDue,
  postgresToolConnectionUrl,
  selectBackupIdsForPruning,
} from "@/lib/system-backup";

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

  it("restores through a clean public schema inside one transaction", () => {
    const plan = databaseRestoreCommandPlan(
      "postgresql://user:pass@localhost:5432/pms?schema=public",
      "/backups/database.dump",
      "/tmp/database.restore.sql",
    );

    expect(plan.render).toEqual({
      command: "pg_restore",
      args: [
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "--file=/tmp/database.restore.sql",
        "/backups/database.dump",
      ],
    });
    expect(plan.apply.command).toBe("psql");
    expect(plan.apply.args).toContain("--single-transaction");
    expect(plan.apply.args).toContain("--set=ON_ERROR_STOP=1");
    expect(plan.apply.args).toContain("--command=DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    expect(plan.apply.args).toContain("--command=SET search_path TO public;");
    expect(plan.apply.args).not.toContain("--clean");
  });

  it("applies post-backup schema migrations in filename order inside the restore transaction", () => {
    const plan = databaseRestoreCommandPlan(
      "postgresql://user:pass@localhost:5432/pms?schema=public",
      "/backups/database.dump",
      "/tmp/database.restore.sql",
      [
        "/app/prisma/manual-migrations/20260730_latest.sql",
        "/app/prisma/manual-migrations/20260724_earlier.sql",
      ],
    );

    expect(plan.apply.args.slice(-4)).toEqual([
      "--file=/tmp/database.restore.sql",
      "--command=SET search_path TO public;",
      "--file=/app/prisma/manual-migrations/20260724_earlier.sql",
      "--file=/app/prisma/manual-migrations/20260730_latest.sql",
    ]);
  });

  it("prunes oldest backups until the total is within the byte limit", () => {
    const result = selectBackupIdsForPruning([
      { id: "oldest", createdAt: new Date("2026-07-24T00:00:00.000Z"), sizeBytes: 3_000 },
      { id: "newer", createdAt: new Date("2026-07-24T01:00:00.000Z"), sizeBytes: 3_000 },
      { id: "latest", createdAt: new Date("2026-07-24T02:00:00.000Z"), sizeBytes: 1_000 },
    ], 5_000);

    expect(result).toEqual({ ids: ["oldest"], totalBytes: 4_000 });
  });

  it("removes an oversized single backup when it cannot fit the limit", () => {
    const result = selectBackupIdsForPruning([
      { id: "oversized", createdAt: new Date("2026-07-24T00:00:00.000Z"), sizeBytes: 6_000 },
    ], 5_000);

    expect(result).toEqual({ ids: ["oversized"], totalBytes: 0 });
  });
});
