ALTER TABLE "ai_usage" ADD COLUMN "cachedInputTokens" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "costSource" TEXT NOT NULL DEFAULT 'catalog';
ALTER TABLE "ai_models" ADD COLUMN "cachedInputPrice" DECIMAL(12,6);
