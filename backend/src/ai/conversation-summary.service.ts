import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { AiQuotaService } from './ai-quota.service';
import { OmniRouterService } from './omnirouter.service';
import { SgdmOptimizationService } from '../sgdm/sgdm-optimization.service';
import { SgdmAccessService } from '../sgdm/sgdm-access.service';
import { OPTIMIZATION_DEFAULTS, OtimizacaoEfetiva } from '../sgdm/optimization-defaults';
import { SUMMARY_MAX_TOKENS, SUMMARY_PROMPT, SUMMARY_RETRY_HINT, chooseSummaryModel, missingItems, planSummary } from './history-summary';

type SummaryJob = { tenantId: string; conversationId: string };
export type SummaryResult = 'criado' | 'rejeitado' | 'ignorado';

const QUEUE = 'conversation.summary';
const ROLE_LABEL: Record<string, string> = { user: 'Usuário', assistant: 'Assistente' };

/**
 * Rebuilds a conversation's history summary in batches, in a BullMQ job after the answer (never on the user's
 * path). Same provider as the conversation, literal legal items checked, messages never deleted. Conversation and
 * summary text stay in i7Ai: logs and audit carry ids and counts only.
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
        this.queue.add('summarize', { tenantId, conversationId }, { jobId: conversationId, attempts: 2, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: true }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('tempo esgotado')), 5000); }),
      ]);
    } catch (error) {
      this.logger.warn('Não foi possível agendar o resumo da conversa ' + conversationId + ' (' + (error instanceof Error ? error.message : String(error)) + ').');
    } finally { if (timeout) clearTimeout(timeout); }
  }

  private async process(job: Job<SummaryJob>) {
    const result = await this.summarize(job.data.tenantId, job.data.conversationId);
    this.logger.log('Resumo da conversa ' + job.data.conversationId + ': ' + result + '.');
  }

  async summarize(tenantId: string, conversationId: string): Promise<SummaryResult> {
    const omniConfigured = Boolean(process.env.OMNIROUTER_BASE_URL || process.env.OMNIROUTER_API_KEY);
    if (!this.omni || !omniConfigured) return 'ignorado';
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { id: true, userId: true, agentId: true, summary: true, summaryThroughMessageId: true, summaryDisabled: true, model: { select: { slug: true } } },
    });
    if (!conversation || conversation.summaryDisabled || !conversation.model) return 'ignorado';
    const agent = await this.prisma.agent.findFirst({ where: { id: conversation.agentId, tenantId }, select: { id: true, status: true } });
    if (!agent || agent.status !== 'ACTIVE') return 'ignorado';
    const cfg: OtimizacaoEfetiva = this.optimization ? await this.optimization.effective(tenantId, agent.id) : structuredClone(OPTIMIZATION_DEFAULTS);
    if (!cfg.resumoHistorico.ligado) return 'ignorado';

    const messages = await this.prisma.message.findMany({ where: { conversationId, role: { in: ['user', 'assistant'] } }, orderBy: { createdAt: 'asc' }, select: { id: true, role: true, content: true, createdAt: true } });
    // SGDM validates N (10–200); clamp anyway so a bad value can never summarize the latest messages.
    const total = Math.min(200, Math.max(10, Math.floor(cfg.resumoHistorico.mensagens) || 20));
    const plan = planSummary(messages, conversation.summaryThroughMessageId, Math.floor(total / 2));
    if (!plan) return 'ignorado';

    // Model: the cheap one of the conversation's provider (active and released) or the conversation's own; never another provider.
    const own = conversation.model.slug;
    const modelos = cfg.resumoHistorico.modelos;
    const cheap = [modelos.openai, modelos.anthropic, modelos.gemini].filter((slug): slug is string => Boolean(slug));
    const rows = await this.prisma.aiModel.findMany({ where: { slug: { in: [own, ...cheap] } }, include: { provider: true } });
    const active = rows.filter(row => row.active !== false).map(row => row.slug);
    let allowed: string[] | null = null;
    // An unconfirmed release list means the cheap model is not confirmed either: fall back to the conversation's model.
    try { allowed = this.access ? (await this.access.allowed(tenantId))?.slugs ?? null : null; } catch { allowed = []; }
    const slug = chooseSummaryModel(own, modelos, active, allowed);
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
      } catch (error) { await this.quota.finish(quotaScope, 'FAILED'); throw error; }
    };

    let summary = await run(source);
    let missing = missingItems(source, summary);
    if (missing.length) {
      summary = await run(source + '\n\n' + SUMMARY_RETRY_HINT + missing.join('; '));
      missing = missingItems(source, summary);
    }
    const audit = (event: string, metadata: Record<string, string | number>) => ({ tenantId, userId: conversation.userId, event, resource: 'conversation', resourceId: conversationId, metadata });
    if (missing.length) {
      // The previous summary stays; the conversation keeps every message after it. Counts only, never text.
      await this.prisma.auditLog.create({ data: audit('conversation.summary_rejected', { missing: missing.length, messages: plan.toSummarize.length }) });
      return 'rejeitado';
    }
    return this.prisma.$transaction(async tx => {
      // Written only if nobody turned the summary off or rebuilt it meanwhile.
      const updated = await tx.conversation.updateMany({
        where: { id: conversationId, tenantId, summaryDisabled: false, summaryThroughMessageId: conversation.summaryThroughMessageId },
        data: { summary, summaryThroughMessageId: plan.throughId, summaryModelId: model.id, summaryUpdatedAt: new Date() },
      });
      if (!updated.count) return 'ignorado' as const;
      await tx.auditLog.create({ data: audit('conversation.summary_created', { messages: plan.toSummarize.length, model: model.slug }) });
      return 'criado' as const;
    });
  }
}
