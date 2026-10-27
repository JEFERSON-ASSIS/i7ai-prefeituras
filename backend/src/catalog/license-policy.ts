import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export async function assertActiveLicense(tx: Pick<Prisma.TransactionClient, 'license'>, tenantId: string) {
  const license = await tx.license.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
  if (!license) {
    if (process.env.NODE_ENV === 'production') throw new ForbiddenException('Prefeitura sem licença ativa');
    return undefined;
  }
  const now = new Date();
  if (license.status !== 'ACTIVE' || license.startDate > now || (license.endDate && license.endDate <= now)) throw new ForbiddenException('Licença da prefeitura está inativa, expirada ou ainda não iniciou');
  return license;
}

export const requireActiveLicense = assertActiveLicense;

// The row lock serializes count-and-create/reactivate operations for a tenant,
// including transactions from different API instances.
export async function assertLicenseCapacity(tx: Prisma.TransactionClient, tenantId: string, resource: 'users' | 'agents' | 'automations' | 'knowledgeBases', excludeId?: string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`);
  const license = await assertActiveLicense(tx, tenantId);
  if (!license) return;
  const count = resource === 'users'
    // Users mirrored without any i7Ai role (only IA_CENTRAL) do not take a seat.
    ? await tx.user.count({ where: { tenantId, status: { not: 'SUSPENDED' }, roles: { some: {} } } })
    : resource === 'agents' ? await tx.agent.count({ where: { tenantId, status: { not: 'ARCHIVED' } } })
    : resource === 'automations' ? await tx.automation.count({ where: { tenantId, status: { not: 'ARCHIVED' }, ...(excludeId ? { id: { not: excludeId } } : {}) } })
    : await tx.knowledgeBase.count({ where: { tenantId } });
  const limit = resource === 'users' ? license.maxUsers : resource === 'agents' ? license.maxAgents : resource === 'automations' ? license.maxAutomations : license.maxKnowledgeBases;
  const labels = { users: 'usuários', agents: 'agentes', automations: 'automações', knowledgeBases: 'bases de conhecimento' };
  if (count >= limit) throw new ForbiddenException(`Limite de ${labels[resource]} da licença atingido`);
}

export async function assertStorageCapacity(tx: Prisma.TransactionClient, tenantId: string, additionalBytes: bigint) {
  if (additionalBytes < 0n) throw new BadRequestException('Tamanho de armazenamento inválido');
  await tx.$queryRaw(Prisma.sql`SELECT id FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`);
  const license = await assertActiveLicense(tx, tenantId);
  if (!license) return;
  const storage = await tx.document.aggregate({ where: { tenantId }, _sum: { sizeBytes: true } });
  if ((storage._sum.sizeBytes ?? 0n) + additionalBytes > license.maxStorageBytes) throw new ForbiddenException('Limite de armazenamento da licença atingido');
}
