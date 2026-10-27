import { BadRequestException, HttpException, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requireActiveLicense } from '../catalog/license-policy';
import { SgdmLimitsService, UserLimits } from '../sgdm/sgdm-limits.service';
import { LIMIT_MESSAGES } from './limit-messages';

/**
 * Counters of one gateway round. inputTokens counts every prompt token, including those read from
 * (cachedInputTokens) and written to (cacheWriteInputTokens) the provider's prompt cache.
 */
export type QuotaUsage = {
  inputTokens: number; outputTokens: number; measured: boolean; cachedInputTokens?: number; gatewayCost?: number;
  cacheWriteInputTokens?: number; cacheHit?: boolean; historySavedTokens?: number; lowDetailImages?: number; highDetailImages?: number;
  requestHash?: string; truncated?: boolean;
};
export type QuotaScope = {
  runId: string; tenantId: string; agentId: string; modelId: string; userId?: string; automationId?: string;
  inputPrice: number; outputPrice: number; cachedInputPrice: number; cacheWriteInputPrice: number; started: number;
  conversationId?: string; kind: 'resposta' | 'resumo';
};
/**
 * Catalog cost in currency units. inputTokens includes the cached (read) and cache-written tokens; read tokens
 * are billed at the cache price and written ones at the cache-write price (both default to the input price).
 */
export function calculateUsageCost(inputTokens: number, outputTokens: number, inputPrice: unknown, outputPrice: unknown, cachedInputTokens = 0, cachedInputPrice: unknown = inputPrice, cacheWriteInputTokens = 0, cacheWriteInputPrice: unknown = inputPrice): number {
  const input = Math.max(0, Number(inputPrice) || 0); const output = Math.max(0, Number(outputPrice) || 0);
  const cachedPrice = Math.max(0, Number(cachedInputPrice) || 0); const writePrice = Math.max(0, Number(cacheWriteInputPrice) || 0);
  const cached = Math.min(Math.max(0, cachedInputTokens), inputTokens);
  const written = Math.min(Math.max(0, cacheWriteInputTokens), inputTokens - cached);
  return Number((((inputTokens - cached - written) * input + cached * cachedPrice + written * writePrice + outputTokens * output) / 1_000_000).toFixed(6));
}
/** Single cost computation shared by the persisted row and the chat response. */
export function usageCost(scope: Pick<QuotaScope, 'inputPrice' | 'outputPrice' | 'cachedInputPrice' | 'cacheWriteInputPrice'>, usage: QuotaUsage): { cost: number; costSource: 'gateway' | 'catalog' } {
  if (usage.gatewayCost !== undefined) return { cost: usage.gatewayCost, costSource: 'gateway' };
  return { cost: calculateUsageCost(usage.inputTokens, usage.outputTokens, scope.inputPrice, scope.outputPrice, usage.cachedInputTokens ?? 0, scope.cachedInputPrice, usage.cacheWriteInputTokens ?? 0, scope.cacheWriteInputPrice), costSource: 'catalog' };
}
const pendingStatuses = ['RESERVED', 'UNCERTAIN'];
/** Refusal when the license has no token balance left for the reservation (the history summary only skips on it). */
export const LICENSE_BALANCE_MESSAGE = 'Saldo de tokens insuficiente para reservar esta chamada. Reduza o limite de resposta ou aguarde as chamadas em andamento.';

@Injectable()
export class AiQuotaService {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly limits?: SgdmLimitsService) {}
  scope(input: Omit<QuotaScope, 'runId' | 'started'>): QuotaScope { return { ...input, runId: randomUUID(), started: Date.now() }; }

  async reserve(scope: QuotaScope, budget: bigint, userLimits: UserLimits | null = null) {
    if (budget < 1n) throw new BadRequestException('Reserva de tokens inválida.');
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM tenants WHERE id = ${scope.tenantId}::uuid FOR UPDATE`);
      const license = await requireActiveLicense(tx, scope.tenantId);
      const now = new Date();
      if (license) {
        const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const from = license.startDate > month ? license.startDate : month;
        const [usage, pending] = await Promise.all([
          // Answers served from the exact cache do not consume the license.
          tx.aiUsage.aggregate({ where: { tenantId: scope.tenantId, createdAt: { gte: from }, cacheHit: false }, _sum: { inputTokens: true, outputTokens: true } }),
          tx.aiTokenReservation.aggregate({ where: { tenantId: scope.tenantId, createdAt: { gte: from }, status: { in: pendingStatuses } }, _sum: { reservedTokens: true } }),
        ]);
        const used = BigInt(usage._sum.inputTokens || 0) + BigInt(usage._sum.outputTokens || 0) + (pending._sum.reservedTokens || 0n);
        if (used + budget > license.maxTokens) throw new BadRequestException(LICENSE_BALANCE_MESSAGE);
      }
      if (scope.userId && userLimits) await this.checkUserLimits(tx, scope.tenantId, scope.userId, userLimits, now);
      return tx.aiTokenReservation.create({ data: { runId: scope.runId, tenantId: scope.tenantId, userId: scope.userId, reservedTokens: budget, createdAt: now } });
    });
  }

  /**
   * Per-user limits from SGDM, checked under the tenant lock. The new call's own size is left out of the
   * per-minute token count, so a single large (e.g. image) request is never refused on its own.
   */
  private async checkUserLimits(tx: Prisma.TransactionClient, tenantId: string, userId: string, limits: UserLimits, now: Date) {
    if (limits.block && limits.monthlyBudgetUsd !== null) {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const spent = await tx.aiUsage.aggregate({ where: { tenantId, userId, createdAt: { gte: month } }, _sum: { cost: true } });
      if (Number(spent._sum.cost ?? 0) >= limits.monthlyBudgetUsd) throw new HttpException(LIMIT_MESSAGES.userMonth, 429);
    }
    const minuteAgo = new Date(now.getTime() - 60_000);
    if (limits.callsPerMinute !== null) {
      const calls = await tx.aiTokenReservation.count({ where: { tenantId, userId, createdAt: { gte: minuteAgo } } });
      if (calls >= limits.callsPerMinute) throw new HttpException(LIMIT_MESSAGES.userMinute, 429);
    }
    if (limits.tokensPerMinute !== null) {
      const [usage, pending] = await Promise.all([
        tx.aiUsage.aggregate({ where: { tenantId, userId, createdAt: { gte: minuteAgo }, cacheHit: false }, _sum: { inputTokens: true, outputTokens: true } }),
        tx.aiTokenReservation.aggregate({ where: { tenantId, userId, createdAt: { gte: minuteAgo }, status: { in: pendingStatuses } }, _sum: { reservedTokens: true } }),
      ]);
      const used = BigInt(usage._sum.inputTokens || 0) + BigInt(usage._sum.outputTokens || 0) + (pending._sum.reservedTokens || 0n);
      if (used >= BigInt(Math.floor(limits.tokensPerMinute))) throw new HttpException(LIMIT_MESSAGES.userMinute, 429);
    }
  }

  async record(scope: QuotaScope, id: string, usage: QuotaUsage) {
    if (![usage.inputTokens, usage.outputTokens, usage.cachedInputTokens ?? 0, usage.cacheWriteInputTokens ?? 0, usage.historySavedTokens ?? 0, usage.lowDetailImages ?? 0, usage.highDetailImages ?? 0].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647)) throw new BadRequestException('Contadores de consumo inválidos.');
    if (usage.requestHash !== undefined && !/^[0-9a-f]{64}$/.test(usage.requestHash)) throw new BadRequestException('Identificador de requisição inválido.');
    const persist = () => this.prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM tenants WHERE id = ${scope.tenantId}::uuid FOR UPDATE`);
      const reservation = await tx.aiTokenReservation.findFirst({ where: { id, runId: scope.runId, tenantId: scope.tenantId } });
      if (!reservation || reservation.status === 'REJECTED') throw new Error('Reserva de consumo não encontrada.');
      const previous = await tx.aiUsage.findUnique({ where: { id } });
      if (previous?.usageMeasured) return;
      const total = BigInt(usage.inputTokens) + BigInt(usage.outputTokens);
      const budget = reservation.reservedTokens + BigInt(previous?.inputTokens || 0) + BigInt(previous?.outputTokens || 0);
      const unresolved = usage.measured ? 0n : (budget > total ? budget - total : 0n);
      const cachedInputTokens = usage.cachedInputTokens ?? 0;
      const { cost, costSource } = usageCost(scope, usage);
      const data = { tenantId: scope.tenantId, agentId: scope.agentId, modelId: scope.modelId, userId: scope.userId, automationId: scope.automationId,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens, cost, costSource, usageMeasured: usage.measured, status: previous?.status || 'PENDING', latencyMs: Date.now() - scope.started,
        // Savings facts; rounds that do not report them keep the column defaults.
        cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0, cacheHit: usage.cacheHit ?? false, historySavedTokens: usage.historySavedTokens ?? 0,
        lowDetailImages: usage.lowDetailImages ?? 0, highDetailImages: usage.highDetailImages ?? 0, requestHash: usage.requestHash ?? null,
        truncated: usage.truncated ?? false, kind: scope.kind ?? 'resposta', conversationId: scope.conversationId ?? null };
      await tx.aiUsage.upsert({ where: { id }, create: { id, ...data, createdAt: reservation.createdAt }, update: data });
      await tx.aiTokenReservation.update({ where: { id }, data: { status: usage.measured ? 'MEASURED' : 'UNCERTAIN', reservedTokens: unresolved, finishedAt: new Date() } });
    });
    try { await persist(); }
    catch (error) {
      if ((error as { code?: string } | null)?.code !== 'P2028') throw error;
      // Retry only persistence, using the same reservation and counters. The
      // tenant lock and measured-usage check also protect an ambiguous commit.
      await persist();
    }
  }

  async runRound<T>(scope: QuotaScope, request: unknown, outputLimit: number, operation: (record: (usage: QuotaUsage) => Promise<void>) => Promise<T>, inputUpperBound?: number): Promise<T> {
    if (!Number.isSafeInteger(outputLimit) || outputLimit < 1) throw new BadRequestException('Limite de resposta inválido.');
    if (inputUpperBound !== undefined && (!Number.isSafeInteger(inputUpperBound) || inputUpperBound < 0)) throw new BadRequestException('Reserva de entrada inválida.');
    // For images, the adapter reserves the verified model context window rather
    // than mistaking base64 bytes for input tokens. Actual usage is still measured.
    const budget = BigInt((inputUpperBound ?? Buffer.byteLength(JSON.stringify(request), 'utf8') + 2048) + outputLimit);
    const userLimits = scope.userId && this.limits ? await this.limits.forUser(scope.tenantId, scope.userId) : null;
    const reservation = await this.reserve(scope, budget, userLimits);
    let reported = false; let receivedUsage = false;
    try {
      const result = await operation(async usage => { receivedUsage = true; await this.record(scope, reservation.id, usage); reported = true; });
      if (!reported) await this.record(scope, reservation.id, { inputTokens: 0, outputTokens: 0, measured: false });
      return result;
    } catch (error) {
      // A failed counter write must retain its reservation, rather than replace
      // known consumption with a fabricated zero report after retry exhaustion.
      if (!reported && !receivedUsage) {
        const candidate = error as { status?: number; providerStatus?: number };
        const rejected = [400, 401, 402, 403, 404, 422, 429].includes(candidate.providerStatus ?? candidate.status ?? 0);
        if (rejected) await this.prisma.aiTokenReservation.update({ where: { id: reservation.id }, data: { status: 'REJECTED', reservedTokens: 0n, finishedAt: new Date() } });
        else await this.record(scope, reservation.id, { inputTokens: 0, outputTokens: 0, measured: false });
      }
      throw error;
    }
  }

  async finish(scope: QuotaScope, status: 'COMPLETED' | 'FAILED', tx: Prisma.TransactionClient = this.prisma) {
    const reservations = await tx.aiTokenReservation.findMany({ where: { runId: scope.runId, tenantId: scope.tenantId }, select: { id: true } });
    if (!reservations.length) return;
    await tx.aiUsage.updateMany({ where: { id: { in: reservations.map(row => row.id) }, tenantId: scope.tenantId, status: 'PENDING' }, data: { status } });
  }
}
