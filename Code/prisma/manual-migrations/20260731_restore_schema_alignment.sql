ALTER TABLE "AssistantAttachment" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "DocumentExtraction" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "DocumentRevision" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "ProjectGanttDeletionBatch" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "ProjectGanttDependency" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "ProjectScheduleImportMetadata" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "ScheduleAnalysisRun" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "SystemBackupSettings" ALTER COLUMN "updatedAt" DROP DEFAULT;
