CREATE TABLE IF NOT EXISTS "ProjectRestoreBatch" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "rolledBackAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PREPARING',
  "operatorId" TEXT NOT NULL DEFAULT '',
  "operatorName" TEXT NOT NULL DEFAULT '',
  "sourceFileName" TEXT NOT NULL DEFAULT '',
  "projectIds" TEXT NOT NULL DEFAULT '[]',
  "projectNames" TEXT NOT NULL DEFAULT '[]',
  "protectionSnapshotDir" TEXT NOT NULL DEFAULT '',
  "summary" TEXT NOT NULL DEFAULT '{}',
  "errorMessage" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "ProjectRestoreBatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ProjectRestoreBatch_createdAt_idx" ON "ProjectRestoreBatch"("createdAt");
CREATE INDEX IF NOT EXISTS "ProjectRestoreBatch_status_expiresAt_idx" ON "ProjectRestoreBatch"("status", "expiresAt");
