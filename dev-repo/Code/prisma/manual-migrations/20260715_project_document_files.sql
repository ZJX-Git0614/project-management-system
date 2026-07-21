CREATE TABLE IF NOT EXISTS "ProjectDocumentFile" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "projectId" TEXT NOT NULL,
  "directoryKey" TEXT NOT NULL,
  "originalName" TEXT NOT NULL,
  "storedName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
  "sizeBytes" INTEGER NOT NULL,
  "uploadedBy" TEXT NOT NULL,
  CONSTRAINT "ProjectDocumentFile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectDocumentFile_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProjectDocumentFile_storedName_key"
  ON "ProjectDocumentFile"("storedName");

CREATE INDEX IF NOT EXISTS "ProjectDocumentFile_projectId_directoryKey_createdAt_idx"
  ON "ProjectDocumentFile"("projectId", "directoryKey", "createdAt");
