ALTER TABLE "ProjectGanttTask"
  ADD COLUMN IF NOT EXISTS "resourceNotBeforeDate" TEXT NOT NULL DEFAULT '';
