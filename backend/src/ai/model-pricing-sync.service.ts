import { Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { sgdmIntegrationEnabled, sgdmIntegrationGet } from '../sgdm/sgdm-integration';
import { litellmCall } from './litellm-admin';

/** SGDM provider slug -> display name of the i7Ai provider created for it. */
const PROVIDER_NAMES: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic (Claude)', gemini: 'Google Gemini' };
const BOOLEAN_CAPABILITIES = ['supportsVision', 'supportsTools', 'supportsReasoning', 'supportsPromptCaching'] as const;
type SgdmModel = { slug: string; nome: string; provedor: string; capacidades?: Record<string, unknown> | null };

function syncInterval() {
  const seconds = Number(process.env.MODEL_SYNC_SECONDS ?? 300);
  return (Number.isFinite(seconds) && seconds >= 30 ? seconds : 300) * 1000;
}
function pricesConfigured() { return Boolean((process.env.OMNIROUTER_BASE_URL || process.env.LITELLM_ADMIN_URL || '').trim()); }

/**
 * Capabilities from the SGDM catalog merged over the current ones. The context window is owned by the
 * LiteLLM price sync (filled only when empty), so the SGDM value is never written here.
 */
function mergeCapabilities(current: Prisma.JsonValue | null | undefined, incoming: Record<string, unknown> | null | undefined) {
  const merged: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current) ? { ...current as Record<string, unknown> } : {};
  const source = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  const output = source.maxOutputTokens;
  if (typeof output === 'number' && Number.isSafeInteger(output) && output >= 1 && output <= 200000) merged.maxOutputTokens = output;
  for (const key of BOOLEAN_CAPABILITIES) if (typeof source[key] === 'boolean') merged[key] = source[key];
  return merged as Prisma.InputJsonObject;
}

/** USD per token -> USD per million tokens as a 6-decimal string; null when absent or out of range. */
function perMillion(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const price = value * 1e6;
  return price < 10000 ? price.toFixed(6) : null;
}

/**
 * Keeps the model catalog in sync. One owner per field: SGDM's Central de IA owns which models exist and are
 * active (plus name and capability flags); the LiteLLM gateway owns prices and the context window.
 */
@Injectable()
export class ModelPricingSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModelPricingSyncService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;
  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() { if (pricesConfigured() || sgdmIntegrationEnabled()) this.schedule(60000); }
  private schedule(delay: number) {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.running = this.runScheduled().finally(() => this.schedule(syncInterval()));
    }, delay);
    this.timer.unref();
  }
  /** One scheduled run: SGDM catalog, then prices. Never throws; logs failure reasons (no keys reach the logs). */
  async runScheduled(): Promise<void> {
    if (sgdmIntegrationEnabled()) {
      try {
        const { upserted, deactivated } = await this.syncCatalog();
        if (deactivated) this.logger.log(`Catálogo de modelos do SGDM: ${upserted} ativos, ${deactivated} desativados.`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`Falha ao sincronizar o catálogo de modelos com o SGDM (${reason}); a próxima execução tentará novamente.`);
      }
    }
    if (!pricesConfigured()) return;
    try {
      const { unknown } = await this.sync();
      if (unknown.length) this.logger.warn(`Modelos sem preço no gateway de IA: ${unknown.join(', ')}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Falha ao sincronizar os preços dos modelos (${reason}); a próxima execução tentará novamente.`);
    }
  }
  async onModuleDestroy() { this.stopping = true; clearTimeout(this.timer); await this.running; }

  /**
   * Mirrors SGDM's active models into ai_models: creates missing providers/models, marks them active and
   * deactivates the rest. Never deletes (usage, conversations and agent bindings reference models) and
   * never touches prices.
   */
  async syncCatalog(): Promise<{ upserted: number; deactivated: number }> {
    const body = await sgdmIntegrationGet<{ modelos?: unknown }>('/integracoes/i7ai/modelos');
    if (!Array.isArray(body?.modelos)) throw new ServiceUnavailableException('O SGDM devolveu um catálogo de modelos inválido.');
    const models = (body.modelos as Partial<SgdmModel>[]).filter((item): item is SgdmModel =>
      typeof item?.slug === 'string' && item.slug.trim() !== '' && typeof item.provedor === 'string' && item.provedor.toLowerCase() in PROVIDER_NAMES);
    const providers = new Map<string, string>();
    const kept: string[] = [];
    for (const item of models) {
      const providerSlug = item.provedor.toLowerCase();
      let providerId = providers.get(providerSlug);
      if (!providerId) {
        const provider = await this.prisma.aiProvider.upsert({ where: { slug: providerSlug }, update: {}, create: { slug: providerSlug, name: PROVIDER_NAMES[providerSlug] }, select: { id: true } });
        providerId = provider.id;
        providers.set(providerSlug, providerId);
      }
      const slug = item.slug.trim();
      const name = (typeof item.nome === 'string' && item.nome.trim() ? item.nome.trim() : slug).slice(0, 160);
      const where = { providerId_slug: { providerId, slug } };
      const existing = await this.prisma.aiModel.findUnique({ where, select: { capabilities: true } });
      const capabilities = mergeCapabilities(existing?.capabilities, item.capacidades);
      const row = await this.prisma.aiModel.upsert({ where, create: { providerId, slug, name, capabilities, active: true }, update: { name, capabilities, active: true }, select: { id: true } });
      if (!kept.includes(row.id)) kept.push(row.id);
    }
    const { count } = await this.prisma.aiModel.updateMany({ where: { active: true, id: { notIn: kept } }, data: { active: false } });
    return { upserted: kept.length, deactivated: count };
  }

  async sync(): Promise<{ updated: number; unknown: string[] }> {
    let payload: unknown;
    try { payload = await litellmCall('GET', '/model/info'); }
    catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Não foi possível ler os preços no gateway de IA.');
    }
    const entries = Array.isArray((payload as { data?: unknown })?.data) ? (payload as { data: unknown[] }).data : [];
    const info = new Map<string, Record<string, unknown>>();
    for (const entry of entries) {
      const item = entry as { model_name?: unknown; model_info?: unknown };
      if (typeof item?.model_name !== 'string' || item.model_name.includes('*')) continue;
      if (item.model_info && typeof item.model_info === 'object') info.set(item.model_name, item.model_info as Record<string, unknown>);
    }
    const models = await this.prisma.aiModel.findMany({ select: { id: true, slug: true, capabilities: true } });
    let updated = 0;
    const unknown: string[] = [];
    for (const model of models) {
      const pricing = info.get(model.slug);
      if (!pricing) { if (!unknown.includes(model.slug)) unknown.push(model.slug); continue; }
      const data: Prisma.AiModelUpdateInput = {};
      const input = perMillion(pricing.input_cost_per_token);
      const output = perMillion(pricing.output_cost_per_token);
      if (input !== null) data.inputPrice = input;
      if (output !== null) data.outputPrice = output;
      // No cache price at LiteLLM: null makes the cost fall back to the input price.
      if (input !== null) data.cachedInputPrice = perMillion(pricing.cache_read_input_token_cost);
      const window = pricing.max_input_tokens;
      const current = model.capabilities && typeof model.capabilities === 'object' && !Array.isArray(model.capabilities) ? model.capabilities as Record<string, unknown> : {};
      // Fill the context window only when empty: an admin-set value is never overwritten.
      if (current.contextWindow == null && typeof window === 'number' && Number.isSafeInteger(window) && window >= 4096 && window <= 2_000_000) {
        data.capabilities = { ...current, contextWindow: window } as Prisma.InputJsonObject;
      }
      if (!Object.keys(data).length) continue;
      await this.prisma.aiModel.update({ where: { id: model.id }, data });
      updated++;
    }
    return { updated, unknown };
  }
}
