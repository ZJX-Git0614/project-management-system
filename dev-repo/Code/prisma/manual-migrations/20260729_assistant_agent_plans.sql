CREATE TABLE IF NOT EXISTS "AssistantPlanRun" (
  "id" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "userId" TEXT NOT NULL,
  "username" TEXT NOT NULL DEFAULT '',
  "displayName" TEXT NOT NULL DEFAULT '',
  "projectId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL DEFAULT '',
  "title" TEXT NOT NULL,
  "goal" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "currentStepIndex" INTEGER NOT NULL DEFAULT 0,
  "inputJson" TEXT NOT NULL DEFAULT '{}',
  "resultJson" TEXT NOT NULL DEFAULT '{}',
  "traceJson" TEXT NOT NULL DEFAULT '[]',
  "errorCode" TEXT NOT NULL DEFAULT '',
  "errorMessage" TEXT NOT NULL DEFAULT '',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "AssistantPlanRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "AssistantPlanStep" (
  "id" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "planId" TEXT NOT NULL,
  "stepIndex" INTEGER NOT NULL,
  "toolId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "command" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "riskLevel" TEXT NOT NULL,
  "dependsOnJson" TEXT NOT NULL DEFAULT '[]',
  "inputJson" TEXT NOT NULL DEFAULT '{}',
  "outputJson" TEXT NOT NULL DEFAULT '{}',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 1,
  "verificationJson" TEXT NOT NULL DEFAULT '{}',
  "errorCode" TEXT NOT NULL DEFAULT '',
  "errorMessage" TEXT NOT NULL DEFAULT '',
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "AssistantPlanStep_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AssistantPlanRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "AssistantActionRun" ADD COLUMN IF NOT EXISTS "planId" TEXT;
ALTER TABLE "AssistantActionRun" ADD COLUMN IF NOT EXISTS "planStepId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "AssistantPlanStep_planId_stepIndex_key" ON "AssistantPlanStep"("planId", "stepIndex");
CREATE INDEX IF NOT EXISTS "AssistantPlanStep_planId_status_idx" ON "AssistantPlanStep"("planId", "status");
CREATE INDEX IF NOT EXISTS "AssistantPlanRun_userId_status_createdAt_idx" ON "AssistantPlanRun"("userId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantPlanRun_projectId_createdAt_idx" ON "AssistantPlanRun"("projectId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantActionRun_planStepId_key" ON "AssistantActionRun"("planStepId");
CREATE INDEX IF NOT EXISTS "AssistantActionRun_planId_status_idx" ON "AssistantActionRun"("planId", "status");

DO $$ BEGIN
  ALTER TABLE "AssistantActionRun" ADD CONSTRAINT "AssistantActionRun_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AssistantPlanRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AssistantActionRun" ADD CONSTRAINT "AssistantActionRun_planStepId_fkey" FOREIGN KEY ("planStepId") REFERENCES "AssistantPlanStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
