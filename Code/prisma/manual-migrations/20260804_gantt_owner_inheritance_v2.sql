-- Backfill legacy parent assignments into still-unassigned descendants.
-- The nearest assigned ancestor wins and existing descendant assignments are preserved.
CREATE TABLE IF NOT EXISTS "PmsDataMigration" (
  "key" TEXT PRIMARY KEY,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

WITH RECURSIVE ancestor_paths AS (
  SELECT
    child."id" AS "taskId",
    parent."id" AS "ancestorId",
    1 AS distance
  FROM "ProjectGanttTask" AS child
  JOIN "ProjectGanttTask" AS parent ON parent."id" = child."parentId"
  WHERE child."ownerMemberId" IS NULL

  UNION ALL

  SELECT
    path."taskId",
    parent."id" AS "ancestorId",
    path.distance + 1
  FROM ancestor_paths AS path
  JOIN "ProjectGanttTask" AS ancestor ON ancestor."id" = path."ancestorId"
  JOIN "ProjectGanttTask" AS parent ON parent."id" = ancestor."parentId"
),
nearest_owner AS (
  SELECT DISTINCT ON (path."taskId")
    path."taskId",
    ancestor."ownerMemberId"
  FROM ancestor_paths AS path
  JOIN "ProjectGanttTask" AS ancestor ON ancestor."id" = path."ancestorId"
  WHERE ancestor."ownerMemberId" IS NOT NULL
  ORDER BY path."taskId", path.distance ASC
)
UPDATE "ProjectGanttTask" AS task
SET "ownerMemberId" = nearest."ownerMemberId"
FROM nearest_owner AS nearest
WHERE task."id" = nearest."taskId"
  AND task."ownerMemberId" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "PmsDataMigration" WHERE "key" = '20260804_gantt_owner_inheritance_v2'
  );

-- Parent values are derived from descendant leaf owners. Multiple project-role rows
-- for the same account count as one person during the compatibility transition.
WITH RECURSIVE descendants AS (
  SELECT parent."id" AS "parentId", child."id" AS "descendantId"
  FROM "ProjectGanttTask" AS parent
  JOIN "ProjectGanttTask" AS child ON child."parentId" = parent."id"

  UNION ALL

  SELECT tree."parentId", child."id" AS "descendantId"
  FROM descendants AS tree
  JOIN "ProjectGanttTask" AS child ON child."parentId" = tree."descendantId"
),
leaf_owners AS (
  SELECT DISTINCT
    tree."parentId",
    COALESCE(member."accountId", 'person:' || member."personName", 'member:' || member."id") AS "identityKey",
    MIN(member."id") OVER (
      PARTITION BY tree."parentId", COALESCE(member."accountId", 'person:' || member."personName", 'member:' || member."id")
    ) AS "canonicalMemberId"
  FROM descendants AS tree
  JOIN "ProjectGanttTask" AS leaf ON leaf."id" = tree."descendantId"
  JOIN "ProjectMember" AS member ON member."id" = leaf."ownerMemberId"
  WHERE NOT EXISTS (
    SELECT 1 FROM "ProjectGanttTask" AS child WHERE child."parentId" = leaf."id"
  )
),
owner_summary AS (
  SELECT
    parent."id" AS "parentId",
    COUNT(DISTINCT owners."identityKey") AS "ownerCount",
    MIN(owners."canonicalMemberId") AS "singleOwnerId"
  FROM "ProjectGanttTask" AS parent
  JOIN "ProjectGanttTask" AS child ON child."parentId" = parent."id"
  LEFT JOIN leaf_owners AS owners ON owners."parentId" = parent."id"
  GROUP BY parent."id"
)
UPDATE "ProjectGanttTask" AS parent
SET "ownerMemberId" = CASE
  WHEN summary."ownerCount" = 1 THEN summary."singleOwnerId"
  ELSE NULL
END
FROM owner_summary AS summary
WHERE parent."id" = summary."parentId"
  AND NOT EXISTS (
    SELECT 1 FROM "PmsDataMigration" WHERE "key" = '20260804_gantt_owner_inheritance_v2'
  )
  AND parent."ownerMemberId" IS DISTINCT FROM CASE
    WHEN summary."ownerCount" = 1 THEN summary."singleOwnerId"
    ELSE NULL
  END;

INSERT INTO "PmsDataMigration" ("key")
VALUES ('20260804_gantt_owner_inheritance_v2')
ON CONFLICT ("key") DO NOTHING;
