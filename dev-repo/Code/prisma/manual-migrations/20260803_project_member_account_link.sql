ALTER TABLE IF EXISTS "ProjectMember"
  ADD COLUMN IF NOT EXISTS "accountId" TEXT;

WITH unique_accounts AS (
  SELECT "displayName", MIN("id") AS "id"
  FROM "UserAccount"
  GROUP BY "displayName"
  HAVING COUNT(*) = 1
)
UPDATE "ProjectMember" AS member
SET "accountId" = account."id"
FROM unique_accounts AS account
WHERE member."accountId" IS NULL
  AND member."personName" = account."displayName";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ProjectMember_accountId_fkey'
      AND conrelid = '"ProjectMember"'::regclass
  ) THEN
    ALTER TABLE "ProjectMember"
      ADD CONSTRAINT "ProjectMember_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "UserAccount"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ProjectMember_projectId_accountId_idx"
  ON "ProjectMember"("projectId", "accountId");
