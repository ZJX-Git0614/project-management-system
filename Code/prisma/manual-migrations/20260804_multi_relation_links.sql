CREATE TABLE IF NOT EXISTS "WeeklyItemGanttTask" (
  "weeklyItemId" TEXT NOT NULL,
  "ganttTaskId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WeeklyItemGanttTask_pkey" PRIMARY KEY ("weeklyItemId", "ganttTaskId")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'WeeklyItemGanttTask_weeklyItemId_fkey'
      AND conrelid = '"WeeklyItemGanttTask"'::regclass
  ) THEN
    ALTER TABLE "WeeklyItemGanttTask"
      ADD CONSTRAINT "WeeklyItemGanttTask_weeklyItemId_fkey"
      FOREIGN KEY ("weeklyItemId") REFERENCES "WeeklyItem"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'WeeklyItemGanttTask_ganttTaskId_fkey'
      AND conrelid = '"WeeklyItemGanttTask"'::regclass
  ) THEN
    ALTER TABLE "WeeklyItemGanttTask"
      ADD CONSTRAINT "WeeklyItemGanttTask_ganttTaskId_fkey"
      FOREIGN KEY ("ganttTaskId") REFERENCES "ProjectGanttTask"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "WeeklyItemGanttTask_ganttTaskId_idx"
  ON "WeeklyItemGanttTask"("ganttTaskId");

CREATE TABLE IF NOT EXISTS "RiskRegisterItemWeeklyItem" (
  "riskItemId" TEXT NOT NULL,
  "weeklyItemId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RiskRegisterItemWeeklyItem_pkey" PRIMARY KEY ("riskItemId", "weeklyItemId")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'RiskRegisterItemWeeklyItem_riskItemId_fkey'
      AND conrelid = '"RiskRegisterItemWeeklyItem"'::regclass
  ) THEN
    ALTER TABLE "RiskRegisterItemWeeklyItem"
      ADD CONSTRAINT "RiskRegisterItemWeeklyItem_riskItemId_fkey"
      FOREIGN KEY ("riskItemId") REFERENCES "RiskRegisterItem"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'RiskRegisterItemWeeklyItem_weeklyItemId_fkey'
      AND conrelid = '"RiskRegisterItemWeeklyItem"'::regclass
  ) THEN
    ALTER TABLE "RiskRegisterItemWeeklyItem"
      ADD CONSTRAINT "RiskRegisterItemWeeklyItem_weeklyItemId_fkey"
      FOREIGN KEY ("weeklyItemId") REFERENCES "WeeklyItem"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "RiskRegisterItemWeeklyItem_weeklyItemId_idx"
  ON "RiskRegisterItemWeeklyItem"("weeklyItemId");

INSERT INTO "WeeklyItemGanttTask" ("weeklyItemId", "ganttTaskId")
SELECT item."id", item."ganttTaskId"
FROM "WeeklyItem" AS item
INNER JOIN "ProjectGanttTask" AS task
  ON task."id" = item."ganttTaskId"
  AND task."projectId" = item."projectId"
WHERE item."ganttTaskId" IS NOT NULL
ON CONFLICT ("weeklyItemId", "ganttTaskId") DO NOTHING;

INSERT INTO "RiskRegisterItemWeeklyItem" ("riskItemId", "weeklyItemId")
SELECT risk."id", risk."weeklyItemId"
FROM "RiskRegisterItem" AS risk
INNER JOIN "WeeklyItem" AS item
  ON item."id" = risk."weeklyItemId"
  AND item."projectId" = risk."projectId"
WHERE risk."weeklyItemId" IS NOT NULL
ON CONFLICT ("riskItemId", "weeklyItemId") DO NOTHING;
