-- Prisma 创建唯一索引前，先合并历史重复项目成员。
-- 老版本尚未包含 accountId 列时跳过；db push 加列后，普通增量迁移会再次执行相同修复。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ProjectMember'
      AND column_name = 'accountId'
  ) THEN
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
      UPDATE "ProjectGanttTask" AS task
      SET "ownerMemberId" = duplicates.canonical_id
      FROM duplicates
      WHERE task."ownerMemberId" = duplicates.id
    $statement$;

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

    EXECUTE $statement$
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
        AND ranked.row_number > 1
    $statement$;

    DROP INDEX IF EXISTS "ProjectMember_projectId_accountId_idx";
    CREATE UNIQUE INDEX IF NOT EXISTS "ProjectMember_projectId_accountId_key"
      ON "ProjectMember"("projectId", "accountId");
  END IF;
END $$;
