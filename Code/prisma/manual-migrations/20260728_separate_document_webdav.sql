ALTER TABLE "SystemBackupSettings"
  ADD COLUMN IF NOT EXISTS "documentCloudEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "documentCloudBaseUrl" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "documentCloudUsername" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "documentCloudPasswordEncrypted" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "documentCloudDirectory" TEXT NOT NULL DEFAULT 'Ceastar-PMS/documents';

UPDATE "SystemBackupSettings"
SET
  "documentCloudEnabled" = "cloudEnabled",
  "documentCloudBaseUrl" = "cloudBaseUrl",
  "documentCloudUsername" = "cloudUsername",
  "documentCloudPasswordEncrypted" = "cloudPasswordEncrypted"
WHERE
  "documentCloudBaseUrl" = ''
  AND "documentCloudUsername" = ''
  AND "documentCloudPasswordEncrypted" = ''
  AND "cloudBaseUrl" <> '';
