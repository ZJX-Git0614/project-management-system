CREATE TABLE IF NOT EXISTS "AssistantChatMessage" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "userId" TEXT NOT NULL,
  "username" TEXT NOT NULL DEFAULT '',
  "displayName" TEXT NOT NULL DEFAULT '',
  "projectId" TEXT NOT NULL DEFAULT '',
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "AssistantChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AssistantChatMessage_userId_projectId_createdAt_idx"
  ON "AssistantChatMessage"("userId", "projectId", "createdAt");

CREATE INDEX IF NOT EXISTS "AssistantChatMessage_createdAt_idx"
  ON "AssistantChatMessage"("createdAt");
