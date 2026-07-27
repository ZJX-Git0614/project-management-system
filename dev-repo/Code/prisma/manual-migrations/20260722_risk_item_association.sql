ALTER TABLE "RiskRegisterItem"
  ADD COLUMN IF NOT EXISTS "riskCode" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "weeklyItemId" TEXT;

CREATE INDEX IF NOT EXISTS "RiskRegisterItem_projectId_weeklyItemId_idx"
  ON "RiskRegisterItem"("projectId", "weeklyItemId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'RiskRegisterItem_weeklyItemId_fkey'
  ) THEN
    ALTER TABLE "RiskRegisterItem"
      ADD CONSTRAINT "RiskRegisterItem_weeklyItemId_fkey"
      FOREIGN KEY ("weeklyItemId") REFERENCES "WeeklyItem"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

WITH ranked AS (
  SELECT
    "id",
    'Risk' || LPAD(ROW_NUMBER() OVER (
      PARTITION BY "projectId"
      ORDER BY "sortOrder", "createdAt", "id"
    )::TEXT, 3, '0') AS "nextCode"
  FROM "RiskRegisterItem"
)
UPDATE "RiskRegisterItem" AS risk
SET "riskCode" = ranked."nextCode"
FROM ranked
WHERE risk."id" = ranked."id";
