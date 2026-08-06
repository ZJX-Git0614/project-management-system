-- Prepare the legacy TodoItem table for the approval workflow schema before
-- `prisma db push`. Prisma treats a new unique column as a possible data-loss
-- operation even when the column is nullable and initially empty. Creating the
-- additive columns and index here keeps the normal schema push non-destructive.

ALTER TABLE "TodoItem"
  ADD COLUMN IF NOT EXISTS "approvalAssignmentId" TEXT,
  ADD COLUMN IF NOT EXISTS "approvalInstanceId" TEXT,
  ADD COLUMN IF NOT EXISTS "collaborationMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS "collaborationThreadId" TEXT,
  ADD COLUMN IF NOT EXISTS "dueAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastRemindedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reminderCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "reminderIntervalHours" INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS "targetAccountId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "TodoItem_approvalAssignmentId_key"
  ON "TodoItem"("approvalAssignmentId");

CREATE INDEX IF NOT EXISTS "TodoItem_collaborationThreadId_targetAccountId_type_status_idx"
  ON "TodoItem"("collaborationThreadId", "targetAccountId", "type", "status");
