-- Model swaps made from SGDM's Central de IA (Entrega 4). Ids only, never conversation text.
CREATE TABLE IF NOT EXISTS "optimization_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "agentId" UUID,
    "kind" TEXT NOT NULL,
    "fromModelId" UUID,
    "toModelId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "optimization_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "optimization_events_tenantId_createdAt_idx" ON "optimization_events"("tenantId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "optimization_events" ADD CONSTRAINT "optimization_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "optimization_events" ADD CONSTRAINT "optimization_events_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
