ALTER TABLE "AssistantChatMessage"
  ADD COLUMN IF NOT EXISTS "trace" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "blocks" TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS "AssistantProvider" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "providerKind" TEXT NOT NULL,
  "providerType" TEXT NOT NULL DEFAULT 'OPENAI_COMPATIBLE',
  "name" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "apiKeyEncrypted" TEXT NOT NULL DEFAULT '',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT NOT NULL DEFAULT '',
  "updatedBy" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "AssistantProvider_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AssistantProvider_providerKind_name_key"
  ON "AssistantProvider"("providerKind", "name");
CREATE INDEX IF NOT EXISTS "AssistantProvider_providerKind_enabled_idx"
  ON "AssistantProvider"("providerKind", "enabled");

CREATE TABLE IF NOT EXISTS "AssistantSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "assistantName" TEXT NOT NULL DEFAULT '项目智能助手',
  "welcomeMessage" TEXT NOT NULL DEFAULT '',
  "systemPrompt" TEXT NOT NULL,
  "personaPreset" TEXT NOT NULL DEFAULT 'PROFESSIONAL',
  "personaCustomPrompt" TEXT NOT NULL DEFAULT '',
  "avatarPalette" TEXT NOT NULL DEFAULT 'ICE',
  "avatarStyle" TEXT NOT NULL DEFAULT 'ROUNDED',
  "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
  "maxTokens" INTEGER NOT NULL DEFAULT 1400,
  "historyLimit" INTEGER NOT NULL DEFAULT 12,
  "historyRetentionDays" INTEGER NOT NULL DEFAULT 90,
  "retrievalEnabled" BOOLEAN NOT NULL DEFAULT false,
  "retrievalTopK" INTEGER NOT NULL DEFAULT 6,
  "chunkMaxSize" INTEGER NOT NULL DEFAULT 2048,
  "vectorDistanceMetric" TEXT NOT NULL DEFAULT 'cosine',
  "vectorSearchMultivector" BOOLEAN NOT NULL DEFAULT true,
  "vectorSearchQueryAdapter" BOOLEAN NOT NULL DEFAULT true,
  "rerankerEnabled" BOOLEAN NOT NULL DEFAULT true,
  "agentEnabled" BOOLEAN NOT NULL DEFAULT true,
  "agentEnabledToolIds" TEXT NOT NULL DEFAULT '[]',
  "agentMaxExportRows" INTEGER NOT NULL DEFAULT 5000,
  "agentActionExpiryMinutes" INTEGER NOT NULL DEFAULT 15,
  "ragliteBaseUrl" TEXT NOT NULL DEFAULT '',
  "ragliteTokenEncrypted" TEXT NOT NULL DEFAULT '',
  "activeLlmProviderId" TEXT,
  "activeEmbeddingProviderId" TEXT,
  "updatedBy" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "AssistantSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AssistantSettingsHistory" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actionType" TEXT NOT NULL,
  "operator" TEXT NOT NULL DEFAULT '',
  "summary" TEXT NOT NULL DEFAULT '',
  "snapshot" TEXT NOT NULL DEFAULT '{}',
  CONSTRAINT "AssistantSettingsHistory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantSettingsHistory_createdAt_idx"
  ON "AssistantSettingsHistory"("createdAt");

CREATE TABLE IF NOT EXISTS "AssistantActionRun" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "userId" TEXT NOT NULL,
  "username" TEXT NOT NULL DEFAULT '',
  "displayName" TEXT NOT NULL DEFAULT '',
  "projectId" TEXT NOT NULL DEFAULT '',
  "messageId" TEXT NOT NULL DEFAULT '',
  "toolId" TEXT NOT NULL,
  "toolVersion" INTEGER NOT NULL DEFAULT 1,
  "riskLevel" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROPOSED',
  "argsJson" TEXT NOT NULL DEFAULT '{}',
  "previewJson" TEXT NOT NULL DEFAULT '{}',
  "resultJson" TEXT NOT NULL DEFAULT '{}',
  "idempotencyKey" TEXT NOT NULL,
  "confirmedAt" TIMESTAMP(3),
  "executedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "errorCode" TEXT NOT NULL DEFAULT '',
  "errorMessage" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "AssistantActionRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantActionRun_idempotencyKey_key"
  ON "AssistantActionRun"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "AssistantActionRun_userId_status_createdAt_idx"
  ON "AssistantActionRun"("userId", "status", "createdAt");
