import { Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { litellmCall } from './litellm-admin';

const SIX_HOURS = 6 * 3600 * 1000;

/** USD per token -> USD per million tokens as a 6-decimal string; null when absent or out of range. */
function perMillion(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const price = value * 1e6;
  return price < 10000 ? price.toFixed(6) : null;
}

/** Keeps prices and context window of the model catalog in sync with the LiteLLM gateway. */
@Injectable()
export class ModelPricingSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModelPricingSyncService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;
  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() { if ((process.env.OMNIROUTER_BASE_URL || '').trim()) this.schedule(60000); }
  private schedule(delay: number) {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.running = this.sync().then(() => undefined, () => this.logger.error('Falha ao sincronizar os preços dos modelos; a próxima execução tentará novamente.')).finally(() => this.schedule(SIX_HOURS));
    }, delay);
    this.timer.unref();
  }
  async onModuleDestroy() { this.stopping = true; clearTimeout(this.timer); await this.running; }

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
      if (typeof window === 'number' && Number.isSafeInteger(window) && window >= 4096 && window <= 2_000_000) {
        const current = model.capabilities && typeof model.capabilities === 'object' && !Array.isArray(model.capabilities) ? model.capabilities : {};
        data.capabilities = { ...current, contextWindow: window } as Prisma.InputJsonObject;
      }
      if (!Object.keys(data).length) continue;
      await this.prisma.aiModel.update({ where: { id: model.id }, data });
      updated++;
    }
    return { updated, unknown };
  }
}
