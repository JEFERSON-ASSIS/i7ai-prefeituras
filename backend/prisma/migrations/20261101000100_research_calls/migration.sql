-- CreateTable
CREATE TABLE "research_calls" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID,
    "agentId" UUID,
    "conversationId" UUID,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "research_calls_tenantId_createdAt_idx" ON "research_calls"("tenantId", "createdAt");
