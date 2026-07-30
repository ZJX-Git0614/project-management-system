ALTER TABLE "Project"
  ADD COLUMN IF NOT EXISTS "ganttRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "ProjectGanttDeletionBatch" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT NOT NULL,
  "operatorUserId" TEXT NOT NULL DEFAULT '',
  "operatorName" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
  "rootTaskIds" TEXT NOT NULL DEFAULT '[]',
  "summary" TEXT NOT NULL DEFAULT '{}',
  "snapshotJson" TEXT NOT NULL DEFAULT '{}',
  "revisionBeforeDelete" INTEGER NOT NULL DEFAULT 0,
  "revisionAfterDelete" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "restoredAt" TIMESTAMP(3),
  CONSTRAINT "ProjectGanttDeletionBatch_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ProjectGanttDeletionBatch_projectId_fkey'
  ) THEN
    ALTER TABLE "ProjectGanttDeletionBatch"
      ADD CONSTRAINT "ProjectGanttDeletionBatch_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ProjectGanttDeletionBatch_projectId_status_createdAt_idx"
  ON "ProjectGanttDeletionBatch"("projectId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "ProjectGanttDeletionBatch_expiresAt_idx"
  ON "ProjectGanttDeletionBatch"("expiresAt");
