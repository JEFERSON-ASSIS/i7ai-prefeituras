-- DropIndex
DROP INDEX "public"."departments_tenantId_name_key";

-- AlterTable
ALTER TABLE "public"."departments" ADD COLUMN     "externalId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenantId_externalId_key" ON "public"."departments"("tenantId", "externalId");

