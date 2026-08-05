CREATE TABLE IF NOT EXISTS "PmsDataMigration" (
  "key" TEXT PRIMARY KEY,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "ProjectGanttTaskOwner" (
  "taskId" TEXT NOT NULL,
  "projectMemberId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectGanttTaskOwner_pkey" PRIMARY KEY ("taskId", "projectMemberId"),
  CONSTRAINT "ProjectGanttTaskOwner_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "ProjectGanttTask"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectGanttTaskOwner_projectMemberId_fkey"
    FOREIGN KEY ("projectMemberId") REFERENCES "ProjectMember"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ProjectGanttTaskOwner_projectMemberId_idx"
  ON "ProjectGanttTaskOwner"("projectMemberId");

INSERT INTO "ProjectGanttTaskOwner" ("taskId", "projectMemberId")
SELECT task."id", task."ownerMemberId"
FROM "ProjectGanttTask" AS task
WHERE task."ownerMemberId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "ProjectGanttTask" AS child WHERE child."parentId" = task."id"
  )
ON CONFLICT ("taskId", "projectMemberId") DO NOTHING;

WITH newly_applied AS (
  INSERT INTO "PmsDataMigration" ("key")
  VALUES ('20260804_existing_gantt_tasks_fixed')
  ON CONFLICT ("key") DO NOTHING
  RETURNING "key"
)
UPDATE "ProjectGanttTask"
SET "taskMode" = 'FIXED'
WHERE EXISTS (SELECT 1 FROM newly_applied)
  AND "taskMode" IN ('AUTO', 'MANUAL', '');
