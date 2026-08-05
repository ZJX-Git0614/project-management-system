CREATE TABLE IF NOT EXISTS "ProjectModuleHistorySnapshot" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "label" TEXT NOT NULL DEFAULT '',
  "snapshotJson" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "ProjectModuleHistorySnapshot_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ProjectModuleHistorySnapshot_projectId_fkey'
      AND conrelid = '"ProjectModuleHistorySnapshot"'::regclass
  ) THEN
    ALTER TABLE "ProjectModuleHistorySnapshot"
      ADD CONSTRAINT "ProjectModuleHistorySnapshot_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ProjectModuleHistorySnapshot_projectId_module_sessionId_createdAt_idx"
  ON "ProjectModuleHistorySnapshot"("projectId", "module", "sessionId", "createdAt");
