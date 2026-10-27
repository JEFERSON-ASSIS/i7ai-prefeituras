-- Rejected history summaries: the batch end and consecutive rejections, so a rejected conversation is not
-- summarized again on every turn (Central de IA, Entrega 4).
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "summaryRejectedThroughMessageId" UUID,
ADD COLUMN IF NOT EXISTS "summaryRejections" INTEGER NOT NULL DEFAULT 0;
