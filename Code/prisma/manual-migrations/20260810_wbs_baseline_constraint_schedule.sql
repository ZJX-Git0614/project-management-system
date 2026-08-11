-- WBS baseline governance and half-day scheduling are additive. Existing
-- schedule modes, dates and dependencies remain intact for compatibility.

ALTER TABLE "Project"
  ADD COLUMN IF NOT EXISTS "ganttHardFinishDate" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "ganttBaselineVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "ganttBaselineState" TEXT NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS "ganttBaselinePublishedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "ganttBaselinePublishedBy" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ProjectGanttTask"
  ADD COLUMN IF NOT EXISTS "startSlot" TEXT NOT NULL DEFAULT 'AM',
  ADD COLUMN IF NOT EXISTS "finishSlot" TEXT NOT NULL DEFAULT 'PM',
  ADD COLUMN IF NOT EXISTS "actualStartSlot" TEXT NOT NULL DEFAULT 'AM',
  ADD COLUMN IF NOT EXISTS "actualFinishSlot" TEXT NOT NULL DEFAULT 'PM',
  ADD COLUMN IF NOT EXISTS "userPriority" TEXT NOT NULL DEFAULT 'MEDIUM',
  ADD COLUMN IF NOT EXISTS "effectivePriority" TEXT NOT NULL DEFAULT 'MEDIUM';

ALTER TABLE "ProjectGanttDependency"
  ADD COLUMN IF NOT EXISTS "unsupportedReason" TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS "ProjectGanttBaseline" (
  "id" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
  "sourceRevision" INTEGER NOT NULL DEFAULT 0,
  "reason" TEXT NOT NULL DEFAULT '',
  "impactJson" TEXT NOT NULL DEFAULT '{}',
  "snapshotJson" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL DEFAULT '',
  "createdByName" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "ProjectGanttBaseline_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProjectGanttBaseline_projectId_version_key"
  ON "ProjectGanttBaseline"("projectId", "version");
CREATE INDEX IF NOT EXISTS "ProjectGanttBaseline_projectId_createdAt_idx"
  ON "ProjectGanttBaseline"("projectId", "createdAt");

CREATE TABLE IF NOT EXISTS "ProjectGanttBaselineDraft" (
  "id" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT NOT NULL,
  "baseVersion" INTEGER NOT NULL DEFAULT 0,
  "sourceRevision" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "reason" TEXT NOT NULL DEFAULT '',
  "snapshotJson" TEXT NOT NULL DEFAULT '{}',
  "impactJson" TEXT NOT NULL DEFAULT '{}',
  "createdByUserId" TEXT NOT NULL DEFAULT '',
  "createdByName" TEXT NOT NULL DEFAULT '',
  "updatedByUserId" TEXT NOT NULL DEFAULT '',
  "updatedByName" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "ProjectGanttBaselineDraft_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProjectGanttBaselineDraft_projectId_key"
  ON "ProjectGanttBaselineDraft"("projectId");
CREATE INDEX IF NOT EXISTS "ProjectGanttBaselineDraft_status_updatedAt_idx"
  ON "ProjectGanttBaselineDraft"("status", "updatedAt");
