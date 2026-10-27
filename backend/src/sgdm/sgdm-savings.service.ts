import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { estimateTokens } from '../ai/history-summary';
import { fixedInstructions } from '../ai/instructions';
import { SgdmAccessService } from './sgdm-access.service';
import { SgdmOptimizationService } from './sgdm-optimization.service';
import { OPTIMIZATION_DEFAULTS, OtimizacaoEfetiva } from './optimization-defaults';
import {
  ExactCacheEstimate, ExactCacheSavings, ImageSavings, ModelSwapSavings, PREFIX_MIN_TOKENS, PromptCacheEstimate, PromptCacheSavings,
  SummaryConversation, SummarySavings, UsageRow, median, percentile, price, summaryEstimate,
} from './savings';

export interface EconomiaItem { realUsd: number | null; estimativaUsd: number | null }
export interface EconomiaPrefeitura {
  cachePrompt: EconomiaItem & { tokensLidos: number; tokensEscritos: number };
  resumoHistorico: EconomiaItem & { resumos: number; rejeitados: number; desligadosPeloUsuario: number };
  cacheExato: EconomiaItem & { acertos: number };
  imagensBaixa: EconomiaItem & { baixa: number; alta: number };
  modeloCaro: EconomiaItem;
  limiteSaida: { realUsd: null; truncadas: number };
}
export interface EconomiaAgente {
  id: string; tenantId: string; nome: string; modeloSlug: string | null; maxTokens: number; temFerramentas: boolean;
  /** The agent's advanced reasoning flag: a swap to a model without reasoning is refused (SGDM skips that suggestion). */
  raciocinioAvancado: boolean;
  chamadas: number; saidaMediana: number | null; saidaP95: number | null; entradaMediana: number | null;
  tokensEntrada: number; tokensCache: number; tokensSaida: number; custoUsd: number; prefixoTokens: number;
}
export interface EconomiaUsuario { id: string; tenantId: string; porModelo: { modeloSlug: string; chamadas: number; curtas: number; custoUsd: number }[] }
export interface EconomiaI7ai {
  periodo: { inicio: string; fim: string };
  prefeituras: Record<string, EconomiaPrefeitura>;
  agentes: EconomiaAgente[];
  usuarios: EconomiaUsuario[];
}
export type EconomiaQuery = { inicio: string; fim: string; from: Date; to: Date; tenantId?: string; saidaCurta: number };
export type ModelSwap = { agentId: string; from: string | null; to: string };

export const MODEL_NOT_RELEASED = 'Este modelo não está liberado para esta prefeitura.';
export const MODEL_WITHOUT_TOOLS = 'O modelo escolhido não aceita as ferramentas deste agente.';
export const MODEL_WITHOUT_REASONING = 'O modelo escolhido não aceita o raciocínio avançado deste agente.';
export const MODEL_CHANGED_SINCE = 'O modelo do agente foi alterado depois da troca; desfaça manualmente.';
/** Rows read per query; the endpoint never holds more than one batch of `ai_usage`. */
export const USAGE_BATCH_SIZE = 5000;
const MAX_SUMMARY_CONVERSATIONS = 2000;
const SUMMARY_EVENTS = ['conversation.summary_created', 'conversation.summary_rejected', 'conversation.summary_disabled'] as const;

const modelSelect = { id: true, slug: true, inputPrice: true, outputPrice: true, cachedInputPrice: true, cacheWriteInputPrice: true, active: true, capabilities: true } satisfies Prisma.AiModelSelect;
type ModelRow = Prisma.AiModelGetPayload<{ select: typeof modelSelect }>;
const round = (value: number) => Number(value.toFixed(6));
/** Same rule as the gateway: anything but an explicit `supportsTools: true` cannot run the agent's tools. */
const supports = (capabilities: unknown, name: 'supportsTools') => Boolean(capabilities) && typeof capabilities === 'object' && !Array.isArray(capabilities) && (capabilities as Record<string, unknown>)[name] === true;
/** Same rule as the gateway's direct path: an explicit `supportsReasoning`, else the o1+/gpt-5+ slug heuristic. */
function supportsReasoning(model: ModelRow) {
  const capabilities = model.capabilities && typeof model.capabilities === 'object' && !Array.isArray(model.capabilities) ? model.capabilities as Record<string, unknown> : {};
  return typeof capabilities.supportsReasoning === 'boolean' ? capabilities.supportsReasoning : /^(o[1-9]([.-]|$)|gpt-[56])/.test(model.slug);
}
const toolsWhere = (tenantId: string) => ({ enabled: true, tool: { tenantId, status: 'ACTIVE' as const } });

type TenantAcc = {
  promptCache: PromptCacheSavings; promptEstimate: PromptCacheEstimate; exact: ExactCacheSavings; exactEstimate: ExactCacheEstimate;
  summary: SummarySavings; images: ImageSavings; swaps: ModelSwapSavings;
  tokensLidos: number; tokensEscritos: number; acertos: number; baixa: number; alta: number; truncadas: number;
};
type AgentAcc = { chamadas: number; input: number[]; output: number[]; tokensEntrada: number; tokensCache: number; tokensSaida: number; custo: number };

function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) { const k = key(item); const list = map.get(k); if (list) list.push(item); else map.set(k, [item]); }
  return map;
}

/**
 * Savings of the Central de IA optimizations, measured from i7Ai's `ai_usage` (every row there is i7Ai's own), and
 * the agent model swap made from the Central. Only ids, counts, tokens and US$ leave this service, never text.
 */
@Injectable()
export class SgdmSavingsService {
  private readonly logger = new Logger(SgdmSavingsService.name);
  /** Overridable by tests to exercise the pagination. */
  batchSize = USAGE_BATCH_SIZE;
  constructor(private readonly prisma: PrismaService, @Optional() private readonly optimization?: SgdmOptimizationService, @Optional() private readonly access?: SgdmAccessService) {}

  private config(tenantId: string, agentId: string): Promise<OtimizacaoEfetiva> {
    return this.optimization ? this.optimization.effective(tenantId, agentId) : Promise.resolve(structuredClone(OPTIMIZATION_DEFAULTS));
  }

  async economia(query: EconomiaQuery): Promise<EconomiaI7ai> {
    const tenantFilter = query.tenantId ? { tenantId: query.tenantId } : {};
    const period = { gte: query.from, lt: query.to };
    const [events, audits] = await Promise.all([
      // Swaps before the period still count: their window covers the period's rows.
      this.prisma.optimizationEvent.findMany({ where: { ...tenantFilter, kind: 'TROCA_MODELO', createdAt: { lt: query.to } }, select: { tenantId: true, agentId: true, kind: true, fromModelId: true, toModelId: true, createdAt: true } }),
      this.prisma.auditLog.groupBy({ by: ['tenantId', 'event'], where: { ...tenantFilter, event: { in: [...SUMMARY_EVENTS] }, createdAt: period }, _count: { _all: true } }),
    ]);
    const models = new Map<string, ModelRow | null>();
    const loadModels = async (ids: (string | null)[]) => {
      const missing = [...new Set(ids.filter((id): id is string => Boolean(id) && !models.has(id as string)))];
      if (!missing.length) return;
      const found = await this.prisma.aiModel.findMany({ where: { id: { in: missing } }, select: modelSelect });
      for (const id of missing) models.set(id, found.find(row => row.id === id) ?? null);
    };
    await loadModels(events.flatMap(event => [event.fromModelId, event.toModelId]));
    const swapsByTenant = group(events.map(event => ({ ...event, from: (event.fromModelId && models.get(event.fromModelId)) || null })), event => event.tenantId);

    // Streamed in (createdAt, id) order; only per-tenant, per-agent and per-user accumulators stay in memory
    // (plus, per agent, the input/output token counts of its answers for the medians and the p95).
    const tenants = new Map<string, TenantAcc>();
    const tenantAcc = async (tenantId: string) => {
      let acc = tenants.get(tenantId);
      if (!acc) {
        const defaults = await this.config(tenantId, '');
        acc = {
          promptCache: new PromptCacheSavings(), promptEstimate: new PromptCacheEstimate(), exact: new ExactCacheSavings(),
          exactEstimate: new ExactCacheEstimate(defaults.cacheExato.ttlSegundos), summary: new SummarySavings(), images: new ImageSavings(),
          swaps: new ModelSwapSavings(swapsByTenant.get(tenantId) ?? []), tokensLidos: 0, tokensEscritos: 0, acertos: 0, baixa: 0, alta: 0, truncadas: 0,
        };
        tenants.set(tenantId, acc);
      }
      return acc;
    };
    if (query.tenantId) await tenantAcc(query.tenantId);
    const agentStats = new Map<string, AgentAcc>();
    const users = new Map<string, { id: string; tenantId: string; porModelo: Map<string, { chamadas: number; curtas: number; custo: number }> }>();
    let cursor: string | undefined; let total = 0;
    for (;;) {
      const batch = await this.prisma.aiUsage.findMany({
        where: { ...tenantFilter, createdAt: period, status: { not: 'PENDING' } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: this.batchSize, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true, tenantId: true, agentId: true, userId: true, modelId: true, inputTokens: true, outputTokens: true, cost: true,
          cachedInputTokens: true, cacheWriteInputTokens: true, cacheHit: true, historySavedTokens: true, lowDetailImages: true,
          highDetailImages: true, requestHash: true, kind: true, truncated: true, createdAt: true,
        },
      });
      if (!batch.length) break;
      await loadModels(batch.map(row => row.modelId));
      for (const raw of batch) {
        const row: UsageRow = { ...raw, model: (raw.modelId && models.get(raw.modelId)) || null };
        const acc = await tenantAcc(row.tenantId);
        acc.promptCache.add(row); acc.promptEstimate.add(row); acc.exact.add(row); acc.exactEstimate.add(row);
        acc.summary.add(row); acc.images.add(row); acc.swaps.add(row);
        // Token totals ignore exact-cache hits (no provider call); US$ sums keep every row.
        if (!row.cacheHit) { acc.tokensLidos += row.cachedInputTokens; acc.tokensEscritos += row.cacheWriteInputTokens; } else acc.acertos++;
        acc.baixa += row.lowDetailImages; acc.alta += row.highDetailImages;
        // Per-agent and per-user statistics only use answers: summaries (up to 1,500 output tokens) would skew the p95.
        if (row.kind !== 'resposta') continue;
        if (row.truncated) acc.truncadas++;
        if (row.agentId) {
          let stats = agentStats.get(row.agentId);
          if (!stats) { stats = { chamadas: 0, input: [], output: [], tokensEntrada: 0, tokensCache: 0, tokensSaida: 0, custo: 0 }; agentStats.set(row.agentId, stats); }
          stats.chamadas++; stats.custo += price(row.cost);
          if (!row.cacheHit) {
            stats.input.push(row.inputTokens); stats.output.push(row.outputTokens);
            stats.tokensEntrada += row.inputTokens; stats.tokensCache += row.cachedInputTokens; stats.tokensSaida += row.outputTokens;
          }
        }
        if (row.userId && row.model) {
          const key = row.tenantId + ':' + row.userId;
          let user = users.get(key);
          if (!user) { user = { id: row.userId, tenantId: row.tenantId, porModelo: new Map() }; users.set(key, user); }
          let byModel = user.porModelo.get(row.model.slug);
          if (!byModel) { byModel = { chamadas: 0, curtas: 0, custo: 0 }; user.porModelo.set(row.model.slug, byModel); }
          byModel.chamadas++; byModel.custo += price(row.cost);
          if (row.outputTokens < query.saidaCurta) byModel.curtas++;
        }
      }
      total += batch.length;
      if (batch.length < this.batchSize) break;
      cursor = batch[batch.length - 1].id;
    }

    const agentIds = [...agentStats.keys()];
    const agents = agentIds.length ? await this.prisma.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, tenantId: true, name: true, systemPrompt: true, maxTokens: true, advancedReasoning: true, models: { select: { isPrimary: true, model: { select: { slug: true } } } } },
    }) : [];
    const withTools = new Set(agentIds.length ? (await this.prisma.agentTool.findMany({ where: { agentId: { in: agentIds }, enabled: true, tool: { status: 'ACTIVE' } }, select: { agentId: true, tool: { select: { tenantId: true } } } }))
      .filter(binding => agents.some(agent => agent.id === binding.agentId && agent.tenantId === binding.tool.tenantId)).map(binding => binding.agentId) : []);
    const prefix = new Map(agents.map(agent => [agent.id, estimateTokens(fixedInstructions(agent, false, true))]));
    const configs = new Map<string, OtimizacaoEfetiva>();
    await Promise.all(agents.map(async agent => configs.set(agent.id, await this.config(agent.tenantId, agent.id))));

    const prefeituras: Record<string, EconomiaPrefeitura> = {};
    for (const [tenantId, acc] of tenants) {
      const count = (event: string) => audits.find(item => item.tenantId === tenantId && item.event === event)?._count._all ?? 0;
      const prefixOff: Record<string, number> = {};
      for (const agent of agents) {
        const tokens = prefix.get(agent.id) ?? 0;
        if (agent.tenantId === tenantId && configs.get(agent.id)?.cachePrompt.ligado === false && tokens >= PREFIX_MIN_TOKENS) prefixOff[agent.id] = tokens;
      }
      const images = acc.images.value();
      prefeituras[tenantId] = {
        cachePrompt: { realUsd: acc.promptCache.value(), estimativaUsd: acc.promptEstimate.value(prefixOff), tokensLidos: acc.tokensLidos, tokensEscritos: acc.tokensEscritos },
        // Priced at the full input price: overstates the savings when the prompt cache is also on (see SummarySavings).
        resumoHistorico: {
          realUsd: acc.summary.value(), estimativaUsd: await this.summaryEstimateFor(tenantId, query, configs),
          resumos: count('conversation.summary_created'), rejeitados: count('conversation.summary_rejected'), desligadosPeloUsuario: count('conversation.summary_disabled'),
        },
        cacheExato: { realUsd: acc.exact.value(), estimativaUsd: acc.exactEstimate.value(), acertos: acc.acertos },
        imagensBaixa: { realUsd: images.real, estimativaUsd: images.estimate, baixa: acc.baixa, alta: acc.alta },
        // The estimate of an expensive model is computed in SGDM (Task 9).
        modeloCaro: { realUsd: acc.swaps.value(), estimativaUsd: null },
        limiteSaida: { realUsd: null, truncadas: acc.truncadas },
      };
    }

    const agentes: EconomiaAgente[] = agents.map(agent => {
      const stats = agentStats.get(agent.id) as AgentAcc;
      const primary = agent.models.find(binding => binding.isPrimary) ?? agent.models[0];
      return {
        id: agent.id, tenantId: agent.tenantId, nome: agent.name, modeloSlug: primary?.model.slug ?? null, maxTokens: agent.maxTokens, temFerramentas: withTools.has(agent.id), raciocinioAvancado: agent.advancedReasoning,
        chamadas: stats.chamadas, saidaMediana: median(stats.output), saidaP95: percentile(stats.output, 95), entradaMediana: median(stats.input),
        tokensEntrada: stats.tokensEntrada, tokensCache: stats.tokensCache, tokensSaida: stats.tokensSaida,
        custoUsd: round(stats.custo), prefixoTokens: prefix.get(agent.id) ?? 0,
      };
    });
    const usuarios: EconomiaUsuario[] = [...users.values()].map(user => ({
      id: user.id, tenantId: user.tenantId,
      porModelo: [...user.porModelo].map(([modeloSlug, item]) => ({ modeloSlug, chamadas: item.chamadas, curtas: item.curtas, custoUsd: round(item.custo) })),
    }));
    this.logger.log(`savings: prefeituras=${tenants.size} linhas=${total} agentes=${agentes.length}`);
    return { periodo: { inicio: query.inicio, fim: query.fim }, prefeituras, agentes, usuarios };
  }

  /** Estimate for the agents with the summary off; null when none of the period's conversations has such an agent. */
  private async summaryEstimateFor(tenantId: string, query: EconomiaQuery, configs: Map<string, OtimizacaoEfetiva>): Promise<number | null> {
    const conversations = await this.prisma.conversation.findMany({
      where: { tenantId, updatedAt: { gte: query.from, lt: query.to } }, orderBy: { updatedAt: 'desc' }, take: MAX_SUMMARY_CONVERSATIONS,
      select: { id: true, agentId: true, modelId: true, agent: { select: { models: { select: { isPrimary: true, modelId: true } } } } },
    });
    const off: { id: string; n: number; modelId: string | null }[] = [];
    for (const conversation of conversations) {
      const cfg = configs.get(conversation.agentId) ?? await this.config(tenantId, conversation.agentId);
      configs.set(conversation.agentId, cfg);
      if (cfg.resumoHistorico.ligado) continue;
      const primary = conversation.agent.models.find(binding => binding.isPrimary) ?? conversation.agent.models[0];
      off.push({ id: conversation.id, n: cfg.resumoHistorico.mensagens, modelId: conversation.modelId ?? primary?.modelId ?? null });
    }
    if (!off.length) return null;
    const modelIds = [...new Set(off.map(item => item.modelId).filter((id): id is string => Boolean(id)))];
    const inputPrices = new Map((modelIds.length ? await this.prisma.aiModel.findMany({ where: { id: { in: modelIds } }, select: { id: true, inputPrice: true } }) : []).map(row => [row.id, row.inputPrice]));
    // Sizes only: the message text never leaves the database for this figure.
    const sizes = await this.prisma.$queryRaw<{ conversationId: string; role: string; chars: number; bytes: number; createdAt: Date }[]>(Prisma.sql`
      SELECT "conversationId"::text AS "conversationId", role, length(content)::int AS chars, octet_length(content)::int AS bytes, "createdAt"
      FROM messages WHERE "conversationId" IN (${Prisma.join(off.map(item => Prisma.sql`${item.id}::uuid`))}) AND role IN ('user', 'assistant')
      ORDER BY "conversationId", "createdAt", id`);
    const messages = group(sizes, row => row.conversationId);
    let total = 0;
    for (const [n, items] of group(off, item => String(item.n))) {
      const list: SummaryConversation[] = items.map(item => ({
        inputPrice: item.modelId ? inputPrices.get(item.modelId) : 0,
        messages: (messages.get(item.id) ?? []).map(row => ({ role: row.role, chars: Number(row.chars), bytes: Number(row.bytes), inPeriod: row.createdAt >= query.from && row.createdAt < query.to })),
      }));
      total += summaryEstimate(list, Number(n));
    }
    return round(total);
  }

  /** Swaps the agent's main model for `slug`, with the checks that keep the agent working. */
  async swapModel(tenantId: string, agentId: string, slug: string): Promise<ModelSwap> {
    const agent = await this.agentOf(tenantId, agentId);
    const target = await this.prisma.aiModel.findFirst({ where: { slug, active: true }, select: modelSelect, orderBy: { id: 'asc' } });
    return this.apply(tenantId, agentId, target, undefined, agent.advancedReasoning);
  }

  /** Back to the `from` of the agent's last swap, with the same checks, recorded as a new swap. */
  async undoSwap(tenantId: string, agentId: string): Promise<ModelSwap> {
    const agent = await this.agentOf(tenantId, agentId);
    const last = await this.prisma.optimizationEvent.findFirst({ where: { tenantId, agentId, kind: 'TROCA_MODELO' }, orderBy: { createdAt: 'desc' } });
    if (!last || !last.fromModelId) throw new BadRequestException('Não há troca de modelo para desfazer neste agente.');
    const current = await this.primaryModel(this.prisma, agentId);
    if ((current?.id ?? null) !== last.toModelId) throw new BadRequestException(MODEL_CHANGED_SINCE);
    const target = await this.prisma.aiModel.findUnique({ where: { id: last.fromModelId }, select: modelSelect });
    return this.apply(tenantId, agentId, target, last.toModelId, agent.advancedReasoning);
  }

  private async agentOf(tenantId: string, agentId: string) {
    const agent = await this.prisma.agent.findFirst({ where: { id: agentId, tenantId }, select: { id: true, advancedReasoning: true } });
    if (!agent) throw new NotFoundException('Agente não encontrado.');
    return agent;
  }

  private async primaryModel(client: Prisma.TransactionClient | PrismaService, agentId: string) {
    const bindings = await client.agentModel.findMany({ where: { agentId }, select: { isPrimary: true, model: { select: { id: true, slug: true } } } });
    return (bindings.find(binding => binding.isPrimary) ?? bindings[0])?.model ?? null;
  }

  /** `expectedFromId`: for an undo, the model the agent must still have once locked (else it changed since). */
  private async apply(tenantId: string, agentId: string, target: ModelRow | null, expectedFromId: string | undefined, advancedReasoning: boolean): Promise<ModelSwap> {
    if (!target || target.active === false) throw new BadRequestException(MODEL_NOT_RELEASED);
    // null = standalone (no SGDM): nothing to filter. An unconfirmed list fails closed (503 from the access service).
    const allowed = this.access ? await this.access.allowed(tenantId) : null;
    if (allowed && !allowed.slugs.includes(target.slug)) throw new BadRequestException(MODEL_NOT_RELEASED);
    if (advancedReasoning && !supportsReasoning(target)) throw new BadRequestException(MODEL_WITHOUT_REASONING);
    if (!supports(target.capabilities, 'supportsTools') && await this.prisma.agentTool.count({ where: { agentId, ...toolsWhere(tenantId) } })) throw new BadRequestException(MODEL_WITHOUT_TOOLS);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM agents WHERE id = ${agentId}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`);
      const from = await this.primaryModel(tx, agentId);
      if (expectedFromId !== undefined && (from?.id ?? null) !== expectedFromId) throw new BadRequestException(MODEL_CHANGED_SINCE);
      if (from?.id === target.id) throw new BadRequestException('O agente já usa este modelo.');
      await tx.agentModel.deleteMany({ where: { agentId } });
      await tx.agentModel.create({ data: { agentId, modelId: target.id, isPrimary: true } });
      await tx.optimizationEvent.create({ data: { tenantId, agentId, kind: 'TROCA_MODELO', fromModelId: from?.id ?? null, toModelId: target.id } });
      await tx.auditLog.create({ data: { tenantId, userId: null, event: 'agent.model_changed_by_platform', resource: 'agents', resourceId: agentId, metadata: { from: from?.slug ?? null, to: target.slug } } });
      return { agentId, from: from?.slug ?? null, to: target.slug };
    });
  }
}
