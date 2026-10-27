-- AlterTable
ALTER TABLE "public"."ai_token_reservations" ADD COLUMN     "userId" UUID;

-- CreateIndex
CREATE INDEX "ai_token_reservations_tenantId_userId_createdAt_idx" ON "public"."ai_token_reservations"("tenantId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_tenantId_userId_createdAt_idx" ON "public"."ai_usage"("tenantId", "userId", "createdAt");

