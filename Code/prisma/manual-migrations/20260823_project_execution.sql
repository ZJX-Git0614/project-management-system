-- Execution stages/work packages reference the existing WBS instead of copying plan data.
CREATE TABLE IF NOT EXISTS "ProjectExecution" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'SHORT_TERM',
  "ownerMemberId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PLANNED',
  "description" TEXT NOT NULL DEFAULT '',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ProjectExecution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProjectExecutionTask" (
  "executionId" TEXT NOT NULL,
  "ganttTaskId" TEXT NOT NULL,
  "relationType" TEXT NOT NULL DEFAULT 'PRIMARY',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectExecutionTask_pkey" PRIMARY KEY ("executionId", "ganttTaskId")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ProjectExecution_projectId_fkey'
      AND conrelid = '"ProjectExecution"'::regclass
  ) THEN
    ALTER TABLE "ProjectExecution"
      ADD CONSTRAINT "ProjectExecution_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ProjectExecution_ownerMemberId_fkey'
      AND conrelid = '"ProjectExecution"'::regclass
  ) THEN
    ALTER TABLE "ProjectExecution"
      ADD CONSTRAINT "ProjectExecution_ownerMemberId_fkey"
      FOREIGN KEY ("ownerMemberId") REFERENCES "ProjectMember"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ProjectExecutionTask_executionId_fkey'
      AND conrelid = '"ProjectExecutionTask"'::regclass
  ) THEN
    ALTER TABLE "ProjectExecutionTask"
      ADD CONSTRAINT "ProjectExecutionTask_executionId_fkey"
      FOREIGN KEY ("executionId") REFERENCES "ProjectExecution"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ProjectExecutionTask_ganttTaskId_fkey'
      AND conrelid = '"ProjectExecutionTask"'::regclass
  ) THEN
    ALTER TABLE "ProjectExecutionTask"
      ADD CONSTRAINT "ProjectExecutionTask_ganttTaskId_fkey"
      FOREIGN KEY ("ganttTaskId") REFERENCES "ProjectGanttTask"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ProjectExecution_projectId_sortOrder_idx"
  ON "ProjectExecution"("projectId", "sortOrder");
CREATE INDEX IF NOT EXISTS "ProjectExecutionTask_ganttTaskId_idx"
  ON "ProjectExecutionTask"("ganttTaskId");
