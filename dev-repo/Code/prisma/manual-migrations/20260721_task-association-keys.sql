ALTER TABLE "WeeklyItem"
  ADD COLUMN IF NOT EXISTS "ganttTaskId" TEXT;

ALTER TABLE "RiskRegisterItem"
  ADD COLUMN IF NOT EXISTS "ganttTaskId" TEXT;

UPDATE "WeeklyItem" AS item
SET "ganttTaskId" = task.id
FROM "ProjectGanttTask" AS task
WHERE item."ganttTaskId" IS NULL
  AND item."projectId" = task."projectId"
  AND item."taskName" <> ''
  AND item."taskName" = task."taskName";

UPDATE "RiskRegisterItem" AS risk
SET "ganttTaskId" = task.id
FROM "ProjectGanttTask" AS task
WHERE risk."ganttTaskId" IS NULL
  AND risk."projectId" = task."projectId"
  AND risk."linkedItemName" <> ''
  AND (
    risk."linkedItemName" = task."taskName"
    OR risk."linkedItemName" = task."taskCode" || ' · ' || task."taskName"
  );

CREATE INDEX IF NOT EXISTS "WeeklyItem_projectId_ganttTaskId_idx"
  ON "WeeklyItem"("projectId", "ganttTaskId");

CREATE INDEX IF NOT EXISTS "RiskRegisterItem_projectId_ganttTaskId_idx"
  ON "RiskRegisterItem"("projectId", "ganttTaskId");

DO $$
BEGIN
  ALTER TABLE "WeeklyItem"
    ADD CONSTRAINT "WeeklyItem_ganttTaskId_fkey"
    FOREIGN KEY ("ganttTaskId") REFERENCES "ProjectGanttTask"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "RiskRegisterItem"
    ADD CONSTRAINT "RiskRegisterItem_ganttTaskId_fkey"
    FOREIGN KEY ("ganttTaskId") REFERENCES "ProjectGanttTask"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
