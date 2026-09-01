CREATE TABLE IF NOT EXISTS "SystemEventLog" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "level" TEXT NOT NULL DEFAULT 'INFO',
  "category" TEXT NOT NULL DEFAULT 'SYSTEM',
  "module" TEXT NOT NULL DEFAULT '',
  "eventType" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL DEFAULT '',
  "operatorName" TEXT NOT NULL DEFAULT '',
  "projectId" TEXT NOT NULL DEFAULT '',
  "projectName" TEXT NOT NULL DEFAULT '',
  "message" TEXT NOT NULL,
  "details" TEXT NOT NULL DEFAULT '{}',
  "traceId" TEXT NOT NULL DEFAULT '',
  "sizeBytes" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "SystemEventLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SystemEventLog_createdAt_idx" ON "SystemEventLog"("createdAt");
CREATE INDEX IF NOT EXISTS "SystemEventLog_level_createdAt_idx" ON "SystemEventLog"("level", "createdAt");
CREATE INDEX IF NOT EXISTS "SystemEventLog_module_createdAt_idx" ON "SystemEventLog"("module", "createdAt");
CREATE INDEX IF NOT EXISTS "SystemEventLog_projectId_createdAt_idx" ON "SystemEventLog"("projectId", "createdAt");
