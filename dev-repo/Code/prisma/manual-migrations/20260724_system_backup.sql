CREATE TABLE IF NOT EXISTS "SystemBackupSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "automaticBackupEnabled" BOOLEAN NOT NULL DEFAULT true,
  "intervalHours" INTEGER NOT NULL DEFAULT 6,
  "localDirectory" TEXT NOT NULL DEFAULT '',
  "retentionCount" INTEGER NOT NULL DEFAULT 28,
  "cloudEnabled" BOOLEAN NOT NULL DEFAULT false,
  "cloudProvider" TEXT NOT NULL DEFAULT 'WEBDAV',
  "cloudBaseUrl" TEXT NOT NULL DEFAULT '',
  "cloudUsername" TEXT NOT NULL DEFAULT '',
  "cloudPasswordEncrypted" TEXT NOT NULL DEFAULT '',
  "cloudDirectory" TEXT NOT NULL DEFAULT 'Ceastar-PMS/backups',
  "lastAutomaticBackupAt" TIMESTAMP(3),
  "lastBackupStatus" TEXT NOT NULL DEFAULT '',
  "lastBackupMessage" TEXT NOT NULL DEFAULT '',
  "updatedBy" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "SystemBackupSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SystemBackupRecord" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "triggerMode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "backupDirectory" TEXT NOT NULL DEFAULT '',
  "databaseFileName" TEXT NOT NULL DEFAULT '',
  "documentArchiveFileName" TEXT NOT NULL DEFAULT '',
  "sizeBytes" INTEGER NOT NULL DEFAULT 0,
  "cloudStatus" TEXT NOT NULL DEFAULT 'SKIPPED',
  "cloudPath" TEXT NOT NULL DEFAULT '',
  "operator" TEXT NOT NULL DEFAULT '',
  "errorMessage" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "SystemBackupRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SystemBackupRecord_createdAt_idx" ON "SystemBackupRecord"("createdAt");
CREATE INDEX IF NOT EXISTS "SystemBackupRecord_status_createdAt_idx" ON "SystemBackupRecord"("status", "createdAt");
