import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { estimateTokens } from '../ai/history-summary';
import { fixedInstructions } from '../ai/instructions';
import { SgdmAccessService } from './sgdm-access.service';
import { SgdmOptimizationService } from './sgdm-optimization.service';
import { OPTIMIZATION_DEFAULTS, OtimizacaoEfetiva } from './optimization-defaults';
import {
  ModelPrices, ModelSwapEvent, SummaryConversation, UsageRow, exactCacheEstimate, exactCacheSavings, imageSavings, median,
  modelSwapSavings, percentile, price, promptCacheEstimate, promptCacheSavings, summaryEstimate, summarySavings,
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
const MAX_SUMMARY_CONVERSATIONS = 2000;
const PREFIX_MIN_TOKENS = 1024;
const SUMMARY_EVENTS = ['conversation.summary_created', 'conversation.summary_rejected', 'conversation.summary_disabled'] as const;

const modelSelect = { id: true, slug: true, inputPrice: true, outputPrice: true, cachedInputPrice: true, cacheWriteInputPrice: true, active: true, capabilities: true } satisfies Prisma.AiModelSelect;
type ModelRow = Prisma.AiModelGetPayload<{ select: typeof modelSelect }>;
const round = (value: number) => Number(value.toFixed(6));
/** Same rule as the gateway: anything but an explicit `supportsTools: true` cannot run the agent's tools. */
const supportsTools = (capabilities: unknown) => Boolean(capabilities) && typeof capabilities === 'object' && !Array.isArray(capabilities) && (capabilities as Record<string, unknown>).supportsTools === true;
const toolsWhere = (tenantId: string) => ({ enabled: true, tool: { tenantId, status: 'ACTIVE' as const } });

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
  constructor(private readonly prisma: PrismaService, @Optional() private readonly optimization?: SgdmOptimizationService, @Optional() private readonly access?: SgdmAccessService) {}

  private config(tenantId: string, agentId: string): Promise<OtimizacaoEfetiva> {
    return this.optimization ? this.optimization.effective(tenantId, agentId) : Promise.resolve(structuredClone(OPTIMIZATION_DEFAULTS));
  }

  async economia(query: EconomiaQuery): Promise<EconomiaI7ai> {
    const tenantFilter = query.tenantId ? { tenantId: query.tenantId } : {};
    const period = { gte: query.from, lt: query.to };
    const [usage, events, audits] = await Promise.all([
      this.prisma.aiUsage.findMany({
        where: { ...tenantFilter, createdAt: period, status: { not: 'PENDING' } },
        select: {
          tenantId: true, agentId: true, userId: true, modelId: true, inputTokens: true, outputTokens: true, cost: true,
          cachedInputTokens: true, cacheWriteInputTokens: true, cacheHit: true, historySavedTokens: true, lowDetailImages: true,
          highDetailImages: true, requestHash: true, kind: true, truncated: true, createdAt: true,
        },
      }),
      // Swaps before the period still count: their window covers the period's rows.
      this.prisma.optimizationEvent.findMany({ where: { ...tenantFilter, kind: 'TROCA_MODELO', createdAt: { lt: query.to } }, select: { tenantId: true, agentId: true, kind: true, fromModelId: true, toModelId: true, createdAt: true } }),
      this.prisma.auditLog.groupBy({ by: ['tenantId', 'event'], where: { ...tenantFilter, event: { in: [...SUMMARY_EVENTS] }, createdAt: period }, _count: { _all: true } }),
    ]);
    const modelIds = new Set<string>();
    for (const row of usage) if (row.modelId) modelIds.add(row.modelId);
    for (const event of events) { if (event.fromModelId) modelIds.add(event.fromModelId); if (event.toModelId) modelIds.add(event.toModelId); }
    const models = new Map((modelIds.size ? await this.prisma.aiModel.findMany({ where: { id: { in: [...modelIds] } }, select: modelSelect }) : []).map(row => [row.id, row]));
    const rows: UsageRow[] = usage.map(row => ({ ...row, model: (row.modelId && models.get(row.modelId)) || null }));
    const swaps: (ModelSwapEvent & { tenantId: string })[] = events.map(event => ({ ...event, from: (event.fromModelId && models.get(event.fromModelId)) || null }));

    const agentIds = [...new Set(rows.map(row => row.agentId).filter((id): id is string => Boolean(id)))];
    const agents = agentIds.length ? await this.prisma.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, tenantId: true, name: true, systemPrompt: true, maxTokens: true, models: { select: { isPrimary: true, model: { select: { slug: true } } } } },
    }) : [];
    const withTools = new Set(agentIds.length ? (await this.prisma.agentTool.findMany({ where: { agentId: { in: agentIds }, enabled: true, tool: { status: 'ACTIVE' } }, select: { agentId: true, tool: { select: { tenantId: true } } } }))
      .filter(binding => agents.some(agent => agent.id === binding.agentId && agent.tenantId === binding.tool.tenantId)).map(binding => binding.agentId) : []);
    const prefix = new Map(agents.map(agent => [agent.id, estimateTokens(fixedInstructions(agent, false, true))]));
    const configs = new Map<string, OtimizacaoEfetiva>();
    await Promise.all(agents.map(async agent => configs.set(agent.id, await this.config(agent.tenantId, agent.id))));

    const tenantIds = new Set(rows.map(row => row.tenantId));
    if (query.tenantId) tenantIds.add(query.tenantId);
    const byTenant = group(rows, row => row.tenantId);
    const prefeituras: Record<string, EconomiaPrefeitura> = {};
    for (const tenantId of tenantIds) {
      const list = byTenant.get(tenantId) ?? [];
      const defaults = await this.config(tenantId, '');
      const count = (event: string) => audits.find(item => item.tenantId === tenantId && item.event === event)?._count._all ?? 0;
      const answers = list.filter(row => row.kind === 'resposta');
      const prefixOff: Record<string, number> = {};
      for (const agent of agents) {
        const tokens = prefix.get(agent.id) ?? 0;
        if (agent.tenantId === tenantId && configs.get(agent.id)?.cachePrompt.ligado === false && tokens >= PREFIX_MIN_TOKENS) prefixOff[agent.id] = tokens;
      }
      const images = imageSavings(list);
      prefeituras[tenantId] = {
        cachePrompt: {
          realUsd: promptCacheSavings(list), estimativaUsd: promptCacheEstimate(list, prefixOff),
          tokensLidos: list.reduce((sum, row) => sum + row.cachedInputTokens, 0), tokensEscritos: list.reduce((sum, row) => sum + row.cacheWriteInputTokens, 0),
        },
        resumoHistorico: {
          realUsd: summarySavings(list), estimativaUsd: await this.summaryEstimateFor(tenantId, query, configs),
          resumos: count('conversation.summary_created'), rejeitados: count('conversation.summary_rejected'), desligadosPeloUsuario: count('conversation.summary_disabled'),
        },
        cacheExato: { realUsd: exactCacheSavings(list), estimativaUsd: exactCacheEstimate(list, defaults.cacheExato.ttlSegundos), acertos: list.filter(row => row.cacheHit).length },
        imagensBaixa: { realUsd: images.real, estimativaUsd: images.estimate, baixa: list.reduce((sum, row) => sum + row.lowDetailImages, 0), alta: list.reduce((sum, row) => sum + row.highDetailImages, 0) },
        // The estimate of an expensive model is computed in SGDM (Task 9).
        modeloCaro: { realUsd: modelSwapSavings(list, swaps.filter(event => event.tenantId === tenantId)), estimativaUsd: null },
        limiteSaida: { realUsd: null, truncadas: answers.filter(row => row.truncated).length },
      };
    }

    // Per-agent and per-user statistics only use answers: summaries (up to 1,500 output tokens) would skew the p95.
    const answers = rows.filter(row => row.kind === 'resposta');
    const answersByAgent = group(answers.filter(row => row.agentId), row => row.agentId as string);
    const agentes: EconomiaAgente[] = agents.filter(agent => answersByAgent.has(agent.id)).map(agent => {
      const list = answersByAgent.get(agent.id) ?? [];
      const output = list.map(row => row.outputTokens); const input = list.map(row => row.inputTokens);
      const primary = agent.models.find(binding => binding.isPrimary) ?? agent.models[0];
      return {
        id: agent.id, tenantId: agent.tenantId, nome: agent.name, modeloSlug: primary?.model.slug ?? null, maxTokens: agent.maxTokens, temFerramentas: withTools.has(agent.id),
        chamadas: list.length, saidaMediana: median(output), saidaP95: percentile(output, 95), entradaMediana: median(input),
        tokensEntrada: input.reduce((a, b) => a + b, 0), tokensCache: list.reduce((sum, row) => sum + row.cachedInputTokens, 0), tokensSaida: output.reduce((a, b) => a + b, 0),
        custoUsd: round(list.reduce((sum, row) => sum + price(row.cost), 0)), prefixoTokens: prefix.get(agent.id) ?? 0,
      };
    });
    const usuarios: EconomiaUsuario[] = [...group(answers.filter(row => row.userId), row => row.tenantId + ':' + row.userId)].map(([, list]) => ({
      id: list[0].userId as string, tenantId: list[0].tenantId,
      porModelo: [...group(list.filter(row => row.model), row => (row.model as ModelPrices).slug)].map(([modeloSlug, items]) => ({
        modeloSlug, chamadas: items.length, curtas: items.filter(row => row.outputTokens < query.saidaCurta).length,
        custoUsd: round(items.reduce((sum, row) => sum + price(row.cost), 0)),
      })),
    }));
    this.logger.log(`savings: prefeituras=${tenantIds.size} linhas=${rows.length} agentes=${agentes.length}`);
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
    await this.agentOf(tenantId, agentId);
    const target = await this.prisma.aiModel.findFirst({ where: { slug, active: true }, select: modelSelect, orderBy: { id: 'asc' } });
    return this.apply(tenantId, agentId, target);
  }

  /** Back to the `from` of the agent's last swap, with the same checks, recorded as a new swap. */
  async undoSwap(tenantId: string, agentId: string): Promise<ModelSwap> {
    await this.agentOf(tenantId, agentId);
    const last = await this.prisma.optimizationEvent.findFirst({ where: { tenantId, agentId, kind: 'TROCA_MODELO' }, orderBy: { createdAt: 'desc' } });
    if (!last || !last.fromModelId) throw new BadRequestException('Não há troca de modelo para desfazer neste agente.');
    const current = await this.primaryModel(this.prisma, agentId);
    if ((current?.id ?? null) !== last.toModelId) throw new BadRequestException('O modelo do agente mudou depois da troca; não há o que desfazer.');
    const target = await this.prisma.aiModel.findUnique({ where: { id: last.fromModelId }, select: modelSelect });
    return this.apply(tenantId, agentId, target);
  }

  private async agentOf(tenantId: string, agentId: string) {
    const agent = await this.prisma.agent.findFirst({ where: { id: agentId, tenantId }, select: { id: true } });
    if (!agent) throw new NotFoundException('Agente não encontrado.');
  }

  private async primaryModel(client: Prisma.TransactionClient | PrismaService, agentId: string) {
    const bindings = await client.agentModel.findMany({ where: { agentId }, select: { isPrimary: true, model: { select: { id: true, slug: true } } } });
    return (bindings.find(binding => binding.isPrimary) ?? bindings[0])?.model ?? null;
  }

  private async apply(tenantId: string, agentId: string, target: ModelRow | null): Promise<ModelSwap> {
    if (!target || target.active === false) throw new BadRequestException(MODEL_NOT_RELEASED);
    // null = standalone (no SGDM): nothing to filter. An unconfirmed list fails closed (503 from the access service).
    const allowed = this.access ? await this.access.allowed(tenantId) : null;
    if (allowed && !allowed.slugs.includes(target.slug)) throw new BadRequestException(MODEL_NOT_RELEASED);
    if (!supportsTools(target.capabilities) && await this.prisma.agentTool.count({ where: { agentId, ...toolsWhere(tenantId) } })) throw new BadRequestException(MODEL_WITHOUT_TOOLS);
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM agents WHERE id = ${agentId}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`);
      const from = await this.primaryModel(tx, agentId);
      if (from?.id === target.id) throw new BadRequestException('O agente já usa este modelo.');
      await tx.agentModel.deleteMany({ where: { agentId } });
      await tx.agentModel.create({ data: { agentId, modelId: target.id, isPrimary: true } });
      await tx.optimizationEvent.create({ data: { tenantId, agentId, kind: 'TROCA_MODELO', fromModelId: from?.id ?? null, toModelId: target.id } });
      await tx.auditLog.create({ data: { tenantId, userId: null, event: 'agent.model_changed_by_platform', resource: 'agents', resourceId: agentId, metadata: { from: from?.slug ?? null, to: target.slug } } });
      return { agentId, from: from?.slug ?? null, to: target.slug };
    });
  }
}
