CREATE TABLE IF NOT EXISTS "AdminAuditLog" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actionType" TEXT NOT NULL,
  "operator" TEXT NOT NULL,
  "projectId" TEXT NOT NULL DEFAULT '',
  "projectName" TEXT NOT NULL DEFAULT '',
  "detail" TEXT NOT NULL,
  "snapshot" TEXT NOT NULL DEFAULT '{}',
  CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AdminAuditLog_createdAt_idx"
  ON "AdminAuditLog"("createdAt");

CREATE INDEX IF NOT EXISTS "AdminAuditLog_projectId_createdAt_idx"
  ON "AdminAuditLog"("projectId", "createdAt");

DO $$
BEGIN
  IF to_regclass('"AssistantSettings"') IS NOT NULL THEN
    ALTER TABLE "AssistantSettings"
      ALTER COLUMN "assistantName" SET DEFAULT '佳佳';

    UPDATE "AssistantSettings"
    SET "assistantName" = '佳佳', "updatedBy" = '系统升级'
    WHERE "id" = 'default'
      AND ("assistantName" = '项目智能助手' OR BTRIM("assistantName") = '');

    UPDATE "AssistantSettings"
    SET "systemPrompt" = REPLACE(
      "systemPrompt",
      '你是 Ceastar 项目管理系统的项目智能助手。',
      '你是 Ceastar 项目管理系统的智能助手佳佳。'
    )
    WHERE "id" = 'default'
      AND "systemPrompt" LIKE '%项目智能助手%';
  END IF;
END $$;
