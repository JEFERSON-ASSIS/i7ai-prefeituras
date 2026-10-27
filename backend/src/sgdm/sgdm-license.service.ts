import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SgdmNotFound, SgdmUnavailable, sgdmIntegrationEnabled, sgdmIntegrationGet } from './sgdm-integration';

/** SGDM's `LicencaI7ai`, with the two big limits already as bigint. Dates are ISO strings (endDate exclusive). */
export type LicenseSnapshot = {
  status: 'ACTIVE' | 'SUSPENDED'; startDate: string; endDate: string | null;
  maxUsers: number; maxAgents: number; maxAutomations: number; maxKnowledgeBases: number;
  maxStorageBytes: bigint; maxTokens: bigint;
};
/** `UsoLicencaI7ai`: what a prefeitura uses of its license; big numbers as strings. */
export type UsageI7ai = { users: number; agents: number; automations: number; knowledgeBases: number; storageBytes: string; tokensThisMonth: string; reservedTokens: string };
/** `LicencaLegadaI7ai`: the newest local license row of a prefeitura, for the SGDM import. */
export type LicencaLegadaI7ai = {
  tenantId: string; status: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED'; startDate: string; endDate: string | null;
  maxUsers: number; maxAgents: number; maxAutomations: number; maxKnowledgeBases: number; maxStorageBytes: string; maxTokens: string;
};

const NO_SGDM_LICENSE = 'Licença local sem cadastro no SGDM; importe na Central de IA.';
const MAX_BIGINT = 9223372036854775807n;

/** SGDM_LICENSE_SYNC_SECONDS; empty, invalid or non-positive values fall back to 60. */
function syncInterval() {
  const raw = process.env.SGDM_LICENSE_SYNC_SECONDS?.trim();
  const value = raw ? Number(raw) : NaN;
  return (Number.isFinite(value) && value > 0 ? value : 60) * 1000;
}

/** Contract cap of the SGDM LicencaDto (0–1.000.000); anything above is a malformed answer (and fits int4). */
const MAX_COUNT = 1_000_000;
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT;
const isInstant = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const bigLimit = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value) || BigInt(value) > MAX_BIGINT) throw new Error('resposta inválida do SGDM');
  return BigInt(value);
};

/** Validates SGDM's `{ licenca: LicencaI7ai | null }`; anything else is treated as an outage. */
function parseLicense(body: unknown): LicenseSnapshot | null {
  const value = body as { licenca?: unknown } | null;
  if (!value || typeof value !== 'object' || !('licenca' in value)) throw new Error('resposta inválida do SGDM');
  if (value.licenca === null) return null;
  const l = value.licenca as Record<string, unknown> | undefined;
  if (!l || typeof l !== 'object' || (l.status !== 'ACTIVE' && l.status !== 'SUSPENDED') || !isInstant(l.startDate)
    || !(l.endDate === null || isInstant(l.endDate)) || !isCount(l.maxUsers) || !isCount(l.maxAgents)
    || !isCount(l.maxAutomations) || !isCount(l.maxKnowledgeBases)) {
    throw new Error('resposta inválida do SGDM');
  }
  // endDate is exclusive (next day 03:00 UTC), so it must come strictly after startDate.
  if (l.endDate !== null && Date.parse(l.endDate as string) <= Date.parse(l.startDate)) throw new Error('resposta inválida do SGDM (fim antes do início)');
  return {
    status: l.status, startDate: l.startDate, endDate: l.endDate as string | null,
    maxUsers: l.maxUsers, maxAgents: l.maxAgents, maxAutomations: l.maxAutomations, maxKnowledgeBases: l.maxKnowledgeBases,
    maxStorageBytes: bigLimit(l.maxStorageBytes), maxTokens: bigLimit(l.maxTokens),
  };
}

/**
 * The prefeitura's license is registered in SGDM's Central de IA; i7Ai keeps a copy in `licenses` so the
 * existing capacity checks (license-policy.ts) keep working. It is copied at login and every
 * SGDM_LICENSE_SYNC_SECONDS. SGDM down never changes anything: the current row stays valid.
 */
@Injectable()
export class SgdmLicenseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SgdmLicenseService.name);
  private readonly warnedWithoutLicense = new Set<string>();
  private readonly quietTenants = new Set<string>();
  private outage = false;
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;
  private stopping = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() { if (sgdmIntegrationEnabled()) this.schedule(30000); }
  async onModuleDestroy() { this.stopping = true; clearTimeout(this.timer); await this.running; }
  private schedule(delay: number) {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.running = this.syncAll().catch(() => undefined).finally(() => this.schedule(syncInterval()));
    }, delay);
    this.timer.unref();
  }

  /** undefined = integration off or SGDM failed (nothing must change); null = SGDM has no license for it. */
  async fetch(tenantId: string): Promise<LicenseSnapshot | null | undefined> {
    return (await this.read(tenantId)).value;
  }

  /**
   * `down` = SGDM itself is unreachable or failing (no answer, timeout, HTTP 5xx): warned once per outage and
   * logged again only after a success. Per-tenant answers (404 = tenant unknown to SGDM, other 4xx, malformed
   * body) are warned once per tenant until that tenant succeeds. Errors never carry the integration key.
   */
  private async read(tenantId: string): Promise<{ value: LicenseSnapshot | null | undefined; down: boolean }> {
    if (!sgdmIntegrationEnabled()) return { value: undefined, down: false };
    try {
      const value = parseLicense(await sgdmIntegrationGet<unknown>('/integracoes/i7ai/licenca/' + encodeURIComponent(tenantId)));
      if (this.outage) {
        this.outage = false;
        this.logger.log('SGDM voltou a responder às consultas de licença.');
      }
      this.quietTenants.delete(tenantId);
      return { value, down: false };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const down = error instanceof SgdmUnavailable && (error.status === undefined || error.status >= 500);
      if (down) {
        if (!this.outage) this.logger.warn('SGDM indisponível ao consultar licenças (' + reason + '); as licenças atuais continuam valendo.');
        this.outage = true;
      } else if (!this.quietTenants.has(tenantId)) {
        this.quietTenants.add(tenantId);
        this.logger.warn(error instanceof SgdmNotFound
          ? 'O SGDM não conhece a prefeitura ' + tenantId + ' (404); a licença atual continua valendo.'
          : 'Não foi possível ler a licença da prefeitura ' + tenantId + ' no SGDM (' + reason + '); a licença atual continua valendo.');
      }
      return { value: undefined, down };
    }
  }

  /** Writes the snapshot into the newest license row (or creates one). `features` are never touched. */
  async apply(tx: Prisma.TransactionClient, tenantId: string, snapshot: LicenseSnapshot | null): Promise<void> {
    const current = await tx.license.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (!snapshot) {
      // Decision 15: a local license SGDM does not know yet stays until it is imported in the Central de IA.
      if (current && !this.warnedWithoutLicense.has(tenantId)) {
        this.warnedWithoutLicense.add(tenantId);
        this.logger.warn(NO_SGDM_LICENSE);
      }
      return;
    }
    this.warnedWithoutLicense.delete(tenantId);
    const data = {
      status: snapshot.status, startDate: new Date(snapshot.startDate), endDate: snapshot.endDate === null ? null : new Date(snapshot.endDate),
      maxUsers: snapshot.maxUsers, maxAgents: snapshot.maxAgents, maxAutomations: snapshot.maxAutomations, maxKnowledgeBases: snapshot.maxKnowledgeBases,
      maxStorageBytes: snapshot.maxStorageBytes, maxTokens: snapshot.maxTokens,
    };
    if (current) await tx.license.update({ where: { id: current.id }, data });
    else await tx.license.create({ data: { tenantId, ...data } });
  }

  /** Copies the SGDM license of every active prefeitura. One failure never stops the others. */
  async syncAll(): Promise<{ synced: number }> {
    if (!sgdmIntegrationEnabled()) return { synced: 0 };
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
    let synced = 0;
    for (const { id } of tenants) {
      const { value: snapshot, down } = await this.read(id);
      // SGDM down: the remaining tenants would only wait for the same timeout; the next round retries.
      if (down) break;
      if (snapshot === undefined) continue;
      try {
        await this.prisma.$transaction(async (tx) => {
          // Same lock as license-policy.ts: no capacity check reads a half-written license.
          await tx.$queryRaw(Prisma.sql`SELECT id FROM tenants WHERE id = ${id}::uuid FOR UPDATE`);
          await this.apply(tx, id, snapshot);
        });
        synced++;
      } catch (error) {
        this.logger.warn('Não foi possível gravar a licença da prefeitura ' + id + ' (' + (error instanceof Error ? error.message : String(error)) + ').');
      }
    }
    return { synced };
  }

  /** What each prefeitura uses of its license (users not suspended, agents and automations not archived). */
  async usage(tenantIds: string[]): Promise<Record<string, UsageI7ai>> {
    const result: Record<string, UsageI7ai> = {};
    const now = new Date();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    for (const tenantId of tenantIds) {
      const [license, users, agents, automations, knowledgeBases, storage, usage] = await Promise.all([
        this.prisma.license.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: { startDate: true } }),
        this.prisma.user.count({ where: { tenantId, status: { not: 'SUSPENDED' } } }),
        this.prisma.agent.count({ where: { tenantId, status: { not: 'ARCHIVED' } } }),
        this.prisma.automation.count({ where: { tenantId, status: { not: 'ARCHIVED' } } }),
        this.prisma.knowledgeBase.count({ where: { tenantId } }),
        this.prisma.document.aggregate({ where: { tenantId }, _sum: { sizeBytes: true } }),
        this.prisma.aiUsage.aggregate({ where: { tenantId, createdAt: { gte: month } }, _sum: { inputTokens: true, outputTokens: true } }),
      ]);
      const from = license && license.startDate > month ? license.startDate : month;
      const reservations = await this.prisma.aiTokenReservation.aggregate({ where: { tenantId, createdAt: { gte: from }, status: { in: ['RESERVED', 'UNCERTAIN'] } }, _sum: { reservedTokens: true } });
      result[tenantId] = {
        users, agents, automations, knowledgeBases,
        storageBytes: (storage._sum.sizeBytes ?? 0n).toString(),
        tokensThisMonth: (BigInt(usage._sum.inputTokens ?? 0) + BigInt(usage._sum.outputTokens ?? 0)).toString(),
        reservedTokens: (reservations._sum.reservedTokens ?? 0n).toString(),
      };
    }
    return result;
  }

  /** The newest license row of each prefeitura, for the one-time import into SGDM. */
  async legacy(): Promise<LicencaLegadaI7ai[]> {
    const rows = await this.prisma.license.findMany({ orderBy: [{ tenantId: 'asc' }, { createdAt: 'desc' }], distinct: ['tenantId'] });
    return rows.map(row => ({
      tenantId: row.tenantId,
      status: row.status === 'ACTIVE' || row.status === 'EXPIRED' ? row.status : 'SUSPENDED',
      startDate: row.startDate.toISOString(), endDate: row.endDate ? row.endDate.toISOString() : null,
      maxUsers: row.maxUsers, maxAgents: row.maxAgents, maxAutomations: row.maxAutomations, maxKnowledgeBases: row.maxKnowledgeBases,
      maxStorageBytes: row.maxStorageBytes.toString(), maxTokens: row.maxTokens.toString(),
    }));
  }
}
