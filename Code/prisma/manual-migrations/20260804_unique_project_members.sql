-- 一个账号在同一项目只保留一条成员身份，角色从账号当前角色动态展示。
WITH ranked AS (
  SELECT
    id,
    "projectId",
    "accountId",
    FIRST_VALUE(id) OVER (
      PARTITION BY "projectId", "accountId"
      ORDER BY "createdAt", id
    ) AS canonical_id,
    ROW_NUMBER() OVER (
      PARTITION BY "projectId", "accountId"
      ORDER BY "createdAt", id
    ) AS row_number
  FROM "ProjectMember"
  WHERE "accountId" IS NOT NULL
), duplicates AS (
  SELECT id, canonical_id
  FROM ranked
  WHERE row_number > 1
)
UPDATE "ProjectGanttTask" AS task
SET "ownerMemberId" = duplicates.canonical_id
FROM duplicates
WHERE task."ownerMemberId" = duplicates.id;

-- 多负责人表在完整恢复的旧库中可能尚未创建，因此仅在表存在时复制关联。
DO $$
BEGIN
  IF to_regclass('public."ProjectGanttTaskOwner"') IS NOT NULL THEN
    EXECUTE $statement$
      WITH ranked AS (
        SELECT
          id,
          FIRST_VALUE(id) OVER (
            PARTITION BY "projectId", "accountId"
            ORDER BY "createdAt", id
          ) AS canonical_id,
          ROW_NUMBER() OVER (
            PARTITION BY "projectId", "accountId"
            ORDER BY "createdAt", id
          ) AS row_number
        FROM "ProjectMember"
        WHERE "accountId" IS NOT NULL
      ), duplicates AS (
        SELECT id, canonical_id FROM ranked WHERE row_number > 1
      )
      INSERT INTO "ProjectGanttTaskOwner" ("taskId", "projectMemberId", "createdAt")
      SELECT link."taskId", duplicates.canonical_id, MIN(link."createdAt")
      FROM "ProjectGanttTaskOwner" AS link
      JOIN duplicates ON duplicates.id = link."projectMemberId"
      GROUP BY link."taskId", duplicates.canonical_id
      ON CONFLICT ("taskId", "projectMemberId") DO NOTHING
    $statement$;
  END IF;
END $$;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "projectId", "accountId"
      ORDER BY "createdAt", id
    ) AS row_number
  FROM "ProjectMember"
  WHERE "accountId" IS NOT NULL
)
DELETE FROM "ProjectMember" AS member
USING ranked
WHERE member.id = ranked.id
  AND ranked.row_number > 1;

DROP INDEX IF EXISTS "ProjectMember_projectId_accountId_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectMember_projectId_accountId_key"
  ON "ProjectMember"("projectId", "accountId");
