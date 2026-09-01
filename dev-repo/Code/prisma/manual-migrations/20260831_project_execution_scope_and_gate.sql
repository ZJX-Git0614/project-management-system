-- 项目执行阶段：将历史 PRIMARY 关联兼容为 DIRECT，并增加范围和出口 Gate 持久化。
UPDATE "ProjectExecutionTask"
SET "relationType" = 'DIRECT'
WHERE "relationType" = 'PRIMARY';

CREATE INDEX IF NOT EXISTS "ProjectExecutionTask_executionId_relationType_idx"
  ON "ProjectExecutionTask" ("executionId", "relationType");

CREATE INDEX IF NOT EXISTS "ProjectGanttTask_projectId_sortOrder_createdAt_idx"
  ON "ProjectGanttTask" ("projectId", "sortOrder", "createdAt");

CREATE TABLE IF NOT EXISTS "ProjectExecutionGate" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT NOT NULL,
  "executionId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "ganttRevision" INTEGER NOT NULL DEFAULT 0,
  "rangeHash" TEXT NOT NULL DEFAULT '',
  "snapshotJson" TEXT NOT NULL DEFAULT '{}',
  "requestNote" TEXT NOT NULL DEFAULT '',
  "approvalInstanceId" TEXT NOT NULL DEFAULT '',
  "requestedAt" TIMESTAMP(3),
  "approvedAt" TIMESTAMP(3),
  "decisionSummary" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "ProjectExecutionGate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProjectExecutionGateCriterion" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "gateId" TEXT NOT NULL,
  "criterionKey" TEXT NOT NULL,
  "criterionType" TEXT NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT true,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "summary" TEXT NOT NULL DEFAULT '',
  "detail" TEXT NOT NULL DEFAULT '',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ProjectExecutionGateCriterion_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ProjectExecutionGate_projectId_fkey'
      AND conrelid = '"ProjectExecutionGate"'::regclass
  ) THEN
    ALTER TABLE "ProjectExecutionGate"
      ADD CONSTRAINT "ProjectExecutionGate_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ProjectExecutionGate_executionId_fkey'
      AND conrelid = '"ProjectExecutionGate"'::regclass
  ) THEN
    ALTER TABLE "ProjectExecutionGate"
      ADD CONSTRAINT "ProjectExecutionGate_executionId_fkey"
      FOREIGN KEY ("executionId") REFERENCES "ProjectExecution"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ProjectExecutionGateCriterion_gateId_fkey'
      AND conrelid = '"ProjectExecutionGateCriterion"'::regclass
  ) THEN
    ALTER TABLE "ProjectExecutionGateCriterion"
      ADD CONSTRAINT "ProjectExecutionGateCriterion_gateId_fkey"
      FOREIGN KEY ("gateId") REFERENCES "ProjectExecutionGate"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ProjectExecutionGate_projectId_executionId_createdAt_idx"
  ON "ProjectExecutionGate" ("projectId", "executionId", "createdAt");
CREATE INDEX IF NOT EXISTS "ProjectExecutionGate_projectId_status_idx"
  ON "ProjectExecutionGate" ("projectId", "status");
CREATE INDEX IF NOT EXISTS "ProjectExecutionGate_approvalInstanceId_idx"
  ON "ProjectExecutionGate" ("approvalInstanceId");
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectExecutionGateCriterion_gateId_criterionKey_key"
  ON "ProjectExecutionGateCriterion" ("gateId", "criterionKey");
CREATE INDEX IF NOT EXISTS "ProjectExecutionGateCriterion_gateId_sortOrder_idx"
  ON "ProjectExecutionGateCriterion" ("gateId", "sortOrder");
