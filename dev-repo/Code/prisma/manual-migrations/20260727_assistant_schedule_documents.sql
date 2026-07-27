CREATE TABLE IF NOT EXISTS "ProjectScheduleSnapshot" (
  "id" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT NOT NULL,
  "sourceFileName" TEXT NOT NULL DEFAULT '',
  "schemaVersion" TEXT NOT NULL DEFAULT '1.0',
  "normalizedJson" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "ProjectScheduleSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ProjectScheduleSnapshot_projectId_createdAt_idx" ON "ProjectScheduleSnapshot"("projectId", "createdAt");

CREATE TABLE IF NOT EXISTS "ScheduleAnalysisRun" (
  "id" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT NOT NULL,
  "snapshotId" TEXT,
  "sourceFileName" TEXT NOT NULL DEFAULT '',
  "statusDate" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'COMPLETED',
  "resultJson" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "ScheduleAnalysisRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ScheduleAnalysisRun_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ProjectScheduleSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ScheduleAnalysisRun_projectId_createdAt_idx" ON "ScheduleAnalysisRun"("projectId", "createdAt");
CREATE INDEX IF NOT EXISTS "ScheduleAnalysisRun_snapshotId_idx" ON "ScheduleAnalysisRun"("snapshotId");

CREATE TABLE IF NOT EXISTS "AssistantAttachment" (
  "id" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "originalName" TEXT NOT NULL,
  "storedName" TEXT NOT NULL UNIQUE,
  "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
  "sizeBytes" INTEGER NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'CHAT',
  "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  "errorMessage" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "AssistantAttachment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AssistantAttachment_projectId_userId_createdAt_idx" ON "AssistantAttachment"("projectId", "userId", "createdAt");

CREATE TABLE IF NOT EXISTS "DocumentExtraction" (
  "id" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attachmentId" TEXT NOT NULL UNIQUE,
  "content" TEXT NOT NULL,
  "structuredJson" TEXT NOT NULL DEFAULT '{}',
  "diagnosticsJson" TEXT NOT NULL DEFAULT '[]',
  CONSTRAINT "DocumentExtraction_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "AssistantAttachment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "DocumentRevision" (
  "id" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT NOT NULL,
  "attachmentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "instruction" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "format" TEXT NOT NULL DEFAULT 'md',
  "status" TEXT NOT NULL DEFAULT 'COMPLETED',
  CONSTRAINT "DocumentRevision_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "AssistantAttachment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "DocumentRevision_projectId_attachmentId_createdAt_idx" ON "DocumentRevision"("projectId", "attachmentId", "createdAt");

CREATE TABLE IF NOT EXISTS "AssistantArtifact" (
  "id" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "attachmentId" TEXT,
  "revisionId" TEXT,
  "type" TEXT NOT NULL DEFAULT 'DOCUMENT_REVISION',
  "fileName" TEXT NOT NULL,
  "storedName" TEXT NOT NULL UNIQUE,
  "mimeType" TEXT NOT NULL DEFAULT 'text/markdown',
  "sizeBytes" INTEGER NOT NULL,
  CONSTRAINT "AssistantArtifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AssistantArtifact_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "AssistantAttachment"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "AssistantArtifact_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "DocumentRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AssistantArtifact_projectId_userId_createdAt_idx" ON "AssistantArtifact"("projectId", "userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantArtifact_revisionId_idx" ON "AssistantArtifact"("revisionId");

UPDATE "AssistantSettings"
SET "agentEnabledToolIds" = '["todo.create","gantt.progress.update","project.export","schedule.analysis.export","document.revision.save","risk.create.from-analysis","todo.create.batch"]'
WHERE "agentEnabledToolIds" IN ('[]', '["todo.create","gantt.progress.update","project.export"]');
