-- Preserve legacy todo ownership while moving approval and collaboration flows to stable account IDs.
-- Only unambiguous enabled-account matches are migrated; duplicate display names remain untouched.
CREATE TABLE IF NOT EXISTS "PmsDataMigration" (
  "key" TEXT PRIMARY KEY,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

WITH newly_applied AS (
  INSERT INTO "PmsDataMigration" ("key")
  VALUES ('20260806_approval_collaboration')
  ON CONFLICT ("key") DO NOTHING
  RETURNING "key"
),
unique_accounts AS (
  SELECT "displayName", MIN("id") AS "accountId"
  FROM "UserAccount"
  WHERE "enabled" = TRUE
  GROUP BY "displayName"
  HAVING COUNT(*) = 1
)
UPDATE "TodoItem" AS todo
SET "targetAccountId" = account."accountId"
FROM unique_accounts AS account
WHERE EXISTS (SELECT 1 FROM newly_applied)
  AND todo."targetAccountId" IS NULL
  AND todo."targetPersonName" IS NOT NULL
  AND todo."targetPersonName" = account."displayName";
