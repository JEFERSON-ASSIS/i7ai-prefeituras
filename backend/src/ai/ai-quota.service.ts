import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requireActiveLicense } from '../catalog/license-policy';

export type QuotaUsage = { inputTokens: number; outputTokens: number; measured: boolean; cachedInputTokens?: number; gatewayCost?: number };
export type QuotaScope = {
  runId: string; tenantId: string; agentId: string; modelId: string; userId?: string; automationId?: string;
  inputPrice: number; outputPrice: number; cachedInputPrice: number; started: number;
};
/** Catalog cost in currency units; cached prompt tokens are billed at the cache price (default: the input price). */
export function calculateUsageCost(inputTokens: number, outputTokens: number, inputPrice: unknown, outputPrice: unknown, cachedInputTokens = 0, cachedInputPrice: unknown = inputPrice): number {
  const input = Math.max(0, Number(inputPrice) || 0); const output = Math.max(0, Number(outputPrice) || 0);
  const cachedPrice = Math.max(0, Number(cachedInputPrice) || 0);
  const cached = Math.min(Math.max(0, cachedInputTokens), inputTokens);
  return Number((((inputTokens - cached) * input + cached * cachedPrice + outputTokens * output) / 1_000_000).toFixed(6));
}
const pendingStatuses = ['RESERVED', 'UNCERTAIN'];

@Injectable()
export class AiQuotaService {
  constructor(private readonly prisma: PrismaService) {}
  scope(input: Omit<QuotaScope, 'runId' | 'started'>): QuotaScope { return { ...input, runId: randomUUID(), started: Date.now() }; }

  async reserve(scope: QuotaScope, budget: bigint) {
    if (budget < 1n) throw new BadRequestException('Reserva de tokens inválida.');
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM tenants WHERE id = ${scope.tenantId}::uuid FOR UPDATE`);
      const license = await requireActiveLicense(tx, scope.tenantId);
      const now = new Date();
      if (license) {
        const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const from = license.startDate > month ? license.startDate : month;
        const [usage, pending] = await Promise.all([
          tx.aiUsage.aggregate({ where: { tenantId: scope.tenantId, createdAt: { gte: from } }, _sum: { inputTokens: true, outputTokens: true } }),
          tx.aiTokenReservation.aggregate({ where: { tenantId: scope.tenantId, createdAt: { gte: from }, status: { in: pendingStatuses } }, _sum: { reservedTokens: true } }),
        ]);
        const used = BigInt(usage._sum.inputTokens || 0) + BigInt(usage._sum.outputTokens || 0) + (pending._sum.reservedTokens || 0n);
        if (used + budget > license.maxTokens) throw new BadRequestException('Saldo de tokens insuficiente para reservar esta chamada. Reduza o limite de resposta ou aguarde as chamadas em andamento.');
      }
      return tx.aiTokenReservation.create({ data: { runId: scope.runId, tenantId: scope.tenantId, reservedTokens: budget, createdAt: now } });
    });
  }

  async record(scope: QuotaScope, id: string, usage: QuotaUsage) {
    if (![usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647)) throw new BadRequestException('Contadores de consumo inválidos.');
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
      const cost = usage.gatewayCost ?? calculateUsageCost(usage.inputTokens, usage.outputTokens, scope.inputPrice, scope.outputPrice, cachedInputTokens, scope.cachedInputPrice);
      const costSource = usage.gatewayCost !== undefined ? 'gateway' : 'catalog';
      const data = { tenantId: scope.tenantId, agentId: scope.agentId, modelId: scope.modelId, userId: scope.userId, automationId: scope.automationId,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens, cost, costSource, usageMeasured: usage.measured, status: previous?.status || 'PENDING', latencyMs: Date.now() - scope.started };
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
    const reservation = await this.reserve(scope, budget);
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
