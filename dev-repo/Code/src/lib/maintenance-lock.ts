import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type MaintenanceLockResult<T> = {
  acquired: boolean;
  result?: T;
};

/**
 * Runs one maintenance job while holding a transaction-scoped PostgreSQL
 * advisory lock. The lock is released automatically on success, failure, or
 * process termination, so a crashed worker cannot leave stale lease state.
 */
export const runWithMaintenanceLock = async <T>(
  lockName: string,
  job: () => Promise<T>,
): Promise<MaintenanceLockResult<T>> => prisma.$transaction(async (tx) => {
  const rows = await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${lockName}, 0)) AS locked
  `);
  if (!rows[0]?.locked) return { acquired: false };
  return { acquired: true, result: await job() };
}, { maxWait: 10_000, timeout: 15 * 60 * 1000 });
