ALTER TABLE "ProjectGanttTask"
  ADD COLUMN IF NOT EXISTS "estimatedWorkHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "actualWorkHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "budgetItemId" TEXT;

ALTER TABLE "SystemBackupRecord"
  ADD COLUMN IF NOT EXISTS "notificationReadAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "notificationReadBy" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ProjectDocumentFile"
  ADD COLUMN IF NOT EXISTS "storageProvider" TEXT NOT NULL DEFAULT 'LOCAL',
  ADD COLUMN IF NOT EXISTS "cloudPath" TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS "ProjectGanttTask_projectId_budgetItemId_idx"
  ON "ProjectGanttTask"("projectId", "budgetItemId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ProjectGanttTask_budgetItemId_fkey'
  ) THEN
    ALTER TABLE "ProjectGanttTask"
      ADD CONSTRAINT "ProjectGanttTask_budgetItemId_fkey"
      FOREIGN KEY ("budgetItemId") REFERENCES "ProjectBudgetItem"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
