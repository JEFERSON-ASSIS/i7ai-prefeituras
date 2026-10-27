import { HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { AiQuotaService } from './ai-quota.service';
import { OmniRouterService } from './omnirouter.service';
import { SgdmOptimizationService } from '../sgdm/sgdm-optimization.service';
import { SgdmAccessService } from '../sgdm/sgdm-access.service';
import { OPTIMIZATION_DEFAULTS, OtimizacaoEfetiva } from '../sgdm/optimization-defaults';
import {
  SUMMARY_MAX_CALLS, SUMMARY_MAX_REJECTIONS, SUMMARY_MAX_TOKENS, SUMMARY_PROMPT, SUMMARY_RETRY_HINT,
  chooseSummaryModel, missingItems, planSummary, summaryBatchLimits, summaryThreshold,
} from './history-summary';

type SummaryJob = { tenantId: string; conversationId: string; calls?: number };
export type SummaryResult = 'criado' | 'rejeitado' | 'ignorado';
/** Model calls already made for this job (across BullMQ attempts) and how to record a new one. */
export type CallBudget = { used: number; max: number; record?: (used: number) => Promise<void> };

const QUEUE = 'conversation.summary';
const ROLE_LABEL: Record<string, string> = { user: 'Usuário', assistant: 'Assistente' };
/** A model call that would fail the same way again: counted as a rejection, never retried. */
class RejectedCall extends Error { constructor(readonly truncated: boolean) { super(); } }

/**
 * Repeatable failures: an answer cut by the token cap, a refused or malformed answer (content filter, invalid finish
 * reason, empty text) and gateway 4xx. Network errors, timeouts, 5xx and rate limits (429) are transient: the job
 * may retry them once, within its two-call budget.
 */
export function repeatableFailure(error: unknown): boolean {
  const value = error as { truncated?: boolean; providerStatus?: number } | null;
  if (value?.truncated) return true;
  if (typeof value?.providerStatus === 'number') return value.providerStatus >= 400 && value.providerStatus < 500 && ![408, 429].includes(value.providerStatus);
  if (!(error instanceof HttpException)) return false;
  return ![408, 429, 503, 504].includes(error.getStatus());
}

/**
 * Rebuilds a conversation's history summary in batches, in a BullMQ job after the answer (never on the user's
 * path). Same provider as the conversation, literal legal items checked, messages never deleted. Conversation and
 * summary text stay in i7Ai: logs and audit carry ids and counts only. Cost is bounded: one job makes at most
 * two model calls (across retries), reads at most one batch, and a rejected conversation waits for N/2 new messages
 * (three rejections in a row stop it until the user turns the summary off and on).
 */
@Injectable()
export class ConversationSummaryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConversationSummaryService.name);
  private connection?: Redis;
  private queue?: Queue<SummaryJob>;
  private worker?: Worker<SummaryJob>;

  constructor(private readonly prisma: PrismaService, private readonly quota: AiQuotaService, @Optional() private readonly omni?: OmniRouterService, @Optional() private readonly optimization?: SgdmOptimizationService, @Optional() private readonly access?: SgdmAccessService) {}

  onModuleInit() {
    const prefix = process.env.QUEUE_PREFIX || 'bull';
    this.connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    this.connection.on('error', error => this.logger.warn('Redis da fila de resumos: ' + error.message));
    this.queue = new Queue<SummaryJob>(QUEUE, { connection: this.connection, prefix });
    this.queue.on('error', () => { /* enqueue() reports failures. */ });
    this.worker = new Worker<SummaryJob>(QUEUE, job => this.process(job), { connection: this.connection, prefix, concurrency: 1 });
    this.worker.on('error', error => this.logger.warn('Fila de resumos: ' + error.message));
  }

  async onModuleDestroy() {
    await this.worker?.close(); await this.queue?.close(); await this.connection?.quit().catch(() => undefined);
  }

  /** Schedules one summary job per conversation (jobId dedupes). Never throws: a queue error only logs a warning. */
  async enqueue(tenantId: string, conversationId: string): Promise<void> {
    if (!this.queue) { this.logger.warn('Fila de resumos indisponível; a conversa ' + conversationId + ' segue com as mensagens completas.'); return; }
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.queue.add('summarize', { tenantId, conversationId, calls: 0 }, { jobId: conversationId, attempts: 2, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: true }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('tempo esgotado')), 5000); }),
      ]);
    } catch (error) {
      this.logger.warn('Não foi possível agendar o resumo da conversa ' + conversationId + ' (' + (error instanceof Error ? error.message : String(error)) + ').');
    } finally { if (timeout) clearTimeout(timeout); }
  }

  private async process(job: Job<SummaryJob>) {
    // The call count lives in the job data, so a retried attempt continues the same budget of two calls.
    const budget: CallBudget = { used: job.data.calls ?? 0, max: SUMMARY_MAX_CALLS, record: used => job.updateData({ ...job.data, calls: used }) };
    const result = await this.summarize(job.data.tenantId, job.data.conversationId, budget);
    this.logger.log('Resumo da conversa ' + job.data.conversationId + ': ' + result + '.');
  }

  async summarize(tenantId: string, conversationId: string, budget: CallBudget = { used: 0, max: SUMMARY_MAX_CALLS }): Promise<SummaryResult> {
    const omniConfigured = Boolean(process.env.OMNIROUTER_BASE_URL || process.env.OMNIROUTER_API_KEY);
    if (!this.omni || !omniConfigured || budget.used >= budget.max) return 'ignorado';
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { id: true, userId: true, agentId: true, summary: true, summaryThroughMessageId: true, summaryDisabled: true, summaryRejectedThroughMessageId: true, summaryRejections: true, model: { select: { slug: true } } },
    });
    if (!conversation || conversation.summaryDisabled || !conversation.model) return 'ignorado';
    if (conversation.summaryRejections >= SUMMARY_MAX_REJECTIONS) return 'ignorado';
    const agent = await this.prisma.agent.findFirst({ where: { id: conversation.agentId, tenantId }, select: { id: true, status: true } });
    if (!agent || agent.status !== 'ACTIVE') return 'ignorado';
    const cfg: OtimizacaoEfetiva = this.optimization ? await this.optimization.effective(tenantId, agent.id) : structuredClone(OPTIMIZATION_DEFAULTS);
    if (!cfg.resumoHistorico.ligado) return 'ignorado';

    const messages = await this.prisma.message.findMany({ where: { conversationId, role: { in: ['user', 'assistant'] } }, orderBy: { createdAt: 'asc' }, select: { id: true, role: true, content: true, createdAt: true } });
    const threshold = summaryThreshold(cfg.resumoHistorico.mensagens);
    const keep = Math.floor(threshold / 2);
    // After a rejection, wait for N/2 more messages past the rejected batch before trying again.
    const rejectedAt = conversation.summaryRejectedThroughMessageId ? messages.findIndex(item => item.id === conversation.summaryRejectedThroughMessageId) : -1;
    if (rejectedAt >= 0 && messages.length - rejectedAt - 1 < keep) return 'ignorado';
    const plan = planSummary(messages, conversation.summaryThroughMessageId, keep, summaryBatchLimits(threshold));
    if (!plan) return 'ignorado';

    // Model: the cheap one of the conversation's provider (active and released to the prefeitura) or the
    // conversation's own (active and released to its owner); never another provider.
    const own = conversation.model.slug;
    const modelos = cfg.resumoHistorico.modelos;
    const cheap = [modelos.openai, modelos.anthropic, modelos.gemini].filter((slug): slug is string => Boolean(slug));
    const rows = await this.prisma.aiModel.findMany({ where: { slug: { in: [own, ...cheap] } }, include: { provider: true } });
    const active = rows.filter(row => row.active !== false).map(row => row.slug);
    // An unconfirmed release list confirms nothing: that model is skipped.
    const released = async (userId?: string) => {
      if (!this.access) return null;
      try { return (await this.access.allowed(tenantId, userId))?.slugs ?? null; } catch { return []; }
    };
    const slug = chooseSummaryModel(own, modelos, active, await released(), await released(conversation.userId));
    const model = slug ? rows.find(row => row.slug === slug) : undefined;
    if (!model) return 'ignorado';

    // Only role and text: document snippets and attachments are resent on every call and never enter the summary.
    const source = (conversation.summary ? 'Resumo anterior:\n' + conversation.summary + '\n\n' : '')
      + 'Mensagens a resumir:\n' + plan.toSummarize.map(item => (ROLE_LABEL[item.role] ?? item.role) + ': ' + item.content).join('\n\n');
    const capabilities = model.capabilities && typeof model.capabilities === 'object' && !Array.isArray(model.capabilities) ? model.capabilities as Record<string, unknown> : {};
    const maxTokens = typeof capabilities.maxOutputTokens === 'number' && capabilities.maxOutputTokens >= 1 ? Math.min(SUMMARY_MAX_TOKENS, Math.floor(capabilities.maxOutputTokens)) : SUMMARY_MAX_TOKENS;
    // The summary call never uses the prompt cache, the exact cache or the agent's output cap.
    const optimization: OtimizacaoEfetiva = { ...cfg, cachePrompt: { ligado: false }, cacheExato: { ...cfg.cacheExato, ligado: false }, limiteSaida: { ligado: false, tokens: null } };
    const omni = this.omni;
    const run = async (message: string) => {
      budget.used++;
      await budget.record?.(budget.used);
      const quotaScope = this.quota.scope({
        tenantId, agentId: agent.id, modelId: model.id, userId: conversation.userId, conversationId, kind: 'resumo',
        inputPrice: Number(model.inputPrice) || 0, outputPrice: Number(model.outputPrice) || 0,
        cachedInputPrice: Number(model.cachedInputPrice ?? model.inputPrice) || 0, cacheWriteInputPrice: Number(model.cacheWriteInputPrice ?? model.inputPrice) || 0,
      });
      try {
        const answer = await omni.generate({
          agent: { id: agent.id, tenantId, systemPrompt: null, temperature: 0, maxTokens, advancedReasoning: false },
          model, instructions: { fixed: SUMMARY_PROMPT, variable: '' }, message, history: [], historyComplete: true, functions: [],
          userId: conversation.userId, origin: 'i7ai-resumo', conversationId, quotaScope, optimization,
        });
        await this.quota.finish(quotaScope, 'COMPLETED');
        return answer.answer;
      } catch (error) {
        await this.quota.finish(quotaScope, 'FAILED');
        // A summary cut by the token cap is a rejection (retrying would cost the same), not a job failure.
        if (repeatableFailure(error)) throw new RejectedCall(Boolean((error as { truncated?: boolean }).truncated));
        throw error;
      }
    };

    let missing: string[] = []; let truncated = false; let failed = false; let summary = '';
    try {
      summary = await run(source);
      missing = missingItems(source, summary);
      if (missing.length && budget.used < budget.max) {
        summary = await run(source + '\n\n' + SUMMARY_RETRY_HINT + missing.join('; '));
        missing = missingItems(source, summary);
      }
    } catch (error) {
      if (!(error instanceof RejectedCall)) throw error;
      truncated = error.truncated; failed = !error.truncated;
    }
    const audit = (event: string, metadata: Record<string, string | number | boolean>) => ({ tenantId, userId: conversation.userId, event, resource: 'conversation', resourceId: conversationId, metadata });
    const unchanged = { id: conversationId, tenantId, summaryDisabled: false, summaryThroughMessageId: conversation.summaryThroughMessageId };
    if (truncated || failed || missing.length) {
      // The previous summary stays; the conversation keeps every message after it. Counts only, never text.
      await this.prisma.$transaction(async tx => {
        await tx.conversation.updateMany({ where: unchanged, data: { summaryRejectedThroughMessageId: plan.throughId, summaryRejections: { increment: 1 } } });
        await tx.auditLog.create({ data: audit('conversation.summary_rejected', { missing: missing.length, messages: plan.toSummarize.length, truncated, failed }) });
      });
      return 'rejeitado';
    }
    return this.prisma.$transaction(async tx => {
      // Written only if nobody turned the summary off or rebuilt it meanwhile.
      const updated = await tx.conversation.updateMany({
        where: unchanged,
        data: { summary, summaryThroughMessageId: plan.throughId, summaryModelId: model.id, summaryUpdatedAt: new Date(), summaryRejectedThroughMessageId: null, summaryRejections: 0 },
      });
      if (!updated.count) return 'ignorado' as const;
      await tx.auditLog.create({ data: audit('conversation.summary_created', { messages: plan.toSummarize.length, model: model.slug }) });
      return 'criado' as const;
    });
  }
}
