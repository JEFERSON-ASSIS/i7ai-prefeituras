-- Conversation history summary (Central de IA, Entrega 4). Messages are never deleted.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "summary" TEXT,
ADD COLUMN IF NOT EXISTS "summaryThroughMessageId" UUID,
ADD COLUMN IF NOT EXISTS "summaryModelId" UUID,
ADD COLUMN IF NOT EXISTS "summaryUpdatedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "summaryDisabled" BOOLEAN NOT NULL DEFAULT false;
