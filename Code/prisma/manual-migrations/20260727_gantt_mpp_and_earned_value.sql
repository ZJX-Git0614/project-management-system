ALTER TABLE "ProjectGanttTask"
  ADD COLUMN IF NOT EXISTS "finishDate" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "durationMinutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "durationFormat" INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS "taskMode" TEXT NOT NULL DEFAULT 'AUTO',
  ADD COLUMN IF NOT EXISTS "isMilestone" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "externalUid" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "wbsCode" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "outlineNumber" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "calendarUid" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "constraintType" INTEGER,
  ADD COLUMN IF NOT EXISTS "constraintDate" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "baselineStartDate" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "baselineFinishDate" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "baselineCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "budgetAtCompletion" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "actualCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "baselines" JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE "ProjectGanttTask"
SET
  "finishDate" = CASE
    WHEN "finishDate" = ''
      AND "startDate" ~ '^\d{4}-\d{2}-\d{2}$'
      AND "durationDays" > 0
      THEN TO_CHAR(
        "startDate"::date
          + (CEIL("durationDays"::numeric)::integer - 1),
        'YYYY-MM-DD'
      )
    ELSE "finishDate"
  END,
  "durationMinutes" = CASE
    WHEN "durationMinutes" <= 0 AND "durationDays" > 0
      THEN ROUND("durationDays"::numeric * 450)::integer
    ELSE "durationMinutes"
  END;

CREATE TABLE IF NOT EXISTS "ProjectGanttDependency" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT NOT NULL,
  "predecessorTaskId" TEXT NOT NULL,
  "successorTaskId" TEXT NOT NULL,
  "type" INTEGER NOT NULL DEFAULT 1,
  "lag" INTEGER NOT NULL DEFAULT 0,
  "lagFormat" INTEGER NOT NULL DEFAULT 7,
  CONSTRAINT "ProjectGanttDependency_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectGanttDependency_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectGanttDependency_predecessorTaskId_fkey" FOREIGN KEY ("predecessorTaskId") REFERENCES "ProjectGanttTask"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectGanttDependency_successorTaskId_fkey" FOREIGN KEY ("successorTaskId") REFERENCES "ProjectGanttTask"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProjectGanttDependency_predecessorTaskId_successorTaskId_key"
  ON "ProjectGanttDependency"("predecessorTaskId", "successorTaskId");
CREATE INDEX IF NOT EXISTS "ProjectGanttDependency_projectId_successorTaskId_idx"
  ON "ProjectGanttDependency"("projectId", "successorTaskId");
CREATE INDEX IF NOT EXISTS "ProjectGanttTask_projectId_externalUid_idx"
  ON "ProjectGanttTask"("projectId", "externalUid");

WITH legacy_links AS (
  SELECT
    successor."id" AS "successorTaskId",
    successor."projectId",
    BTRIM(link_name) AS task_name
  FROM "ProjectGanttTask" successor,
    LATERAL regexp_split_to_table(successor."predecessorTask", '[,，、;；]') AS link_name
  WHERE BTRIM(link_name) <> ''
), unique_matches AS (
  SELECT
    legacy_links."successorTaskId",
    legacy_links."projectId",
    predecessor."id" AS "predecessorTaskId",
    COUNT(*) OVER (PARTITION BY legacy_links."successorTaskId", legacy_links.task_name) AS match_count
  FROM legacy_links
  JOIN "ProjectGanttTask" predecessor
    ON predecessor."projectId" = legacy_links."projectId"
   AND predecessor."taskName" = legacy_links.task_name
   AND predecessor."id" <> legacy_links."successorTaskId"
)
INSERT INTO "ProjectGanttDependency" (
  "id", "createdAt", "updatedAt", "projectId",
  "predecessorTaskId", "successorTaskId", "type", "lag", "lagFormat"
)
SELECT
  'legacy_' || md5("projectId" || ':' || "predecessorTaskId" || ':' || "successorTaskId"),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  "projectId", "predecessorTaskId", "successorTaskId", 1, 0, 7
FROM unique_matches
WHERE match_count = 1
ON CONFLICT ("predecessorTaskId", "successorTaskId") DO NOTHING;

CREATE TABLE IF NOT EXISTS "ProjectScheduleImportMetadata" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT NOT NULL,
  "sourceFileName" TEXT NOT NULL DEFAULT '',
  "projectSettings" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "calendars" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "resources" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "assignments" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "taskUidMap" JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "ProjectScheduleImportMetadata_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectScheduleImportMetadata_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProjectScheduleImportMetadata_projectId_key"
  ON "ProjectScheduleImportMetadata"("projectId");
