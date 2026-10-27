-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "theme" VARCHAR(30),
ADD COLUMN     "themeVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "conversations_createdAt_idx" ON "conversations"("createdAt");

-- CreateIndex
CREATE INDEX "conversations_tenantId_createdAt_idx" ON "conversations"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "conversations_themeVersion_idx" ON "conversations"("themeVersion");

