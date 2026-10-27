-- Cache-write price per model and the savings facts of each AI call (Central de IA, Entrega 4).
ALTER TABLE "ai_models" ADD COLUMN "cacheWriteInputPrice" DECIMAL(12,6);

ALTER TABLE "ai_usage" ADD COLUMN "cacheWriteInputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "cacheHit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "historySavedTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lowDetailImages" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "highDetailImages" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "requestHash" CHAR(64),
ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'resposta',
ADD COLUMN "truncated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "conversationId" UUID;

-- CreateIndex
CREATE INDEX "ai_usage_tenantId_agentId_createdAt_idx" ON "ai_usage"("tenantId", "agentId", "createdAt");
