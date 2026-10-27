import { Injectable, Logger } from '@nestjs/common';
import { CachedFetch, envSeconds, sgdmFailureSeconds } from '../sgdm/cached-fetch';
import { SgdmNotFound, sgdmIntegrationEnabled, sgdmIntegrationGet } from '../sgdm/sgdm-integration';

export type ResearchConfig = { serperKey: string | null; costPerSearchUsd: number };

export const DEFAULT_COST_PER_SEARCH_USD = 0.001;
const STALE_SECONDS = 600;
const KEY = 'pesquisa';

/** SGDM_RESEARCH_CACHE_SECONDS; empty, invalid or negative values fall back to 60. */
const cacheSeconds = () => envSeconds('SGDM_RESEARCH_CACHE_SECONDS', 60);

const fallback = (): ResearchConfig => ({ serperKey: null, costPerSearchUsd: DEFAULT_COST_PER_SEARCH_USD });

/** Validates SGDM's `{ serperChave: string | null, custoPesquisaUsd: number }`; anything else is an outage. */
function parse(body: unknown): ResearchConfig {
  const value = body as Record<string, unknown> | null;
  if (!value || typeof value !== 'object') throw new Error('resposta inválida do SGDM');
  const { serperChave, custoPesquisaUsd } = value;
  if (!(serperChave === null || typeof serperChave === 'string') || typeof custoPesquisaUsd !== 'number' || !Number.isFinite(custoPesquisaUsd) || custoPesquisaUsd < 0) {
    throw new Error('resposta inválida do SGDM');
  }
  return { serperKey: serperChave && serperChave.trim() ? serperChave.trim() : null, costPerSearchUsd: custoPesquisaUsd };
}

/**
 * Web-search settings (Serper key and cost per search) kept in SGDM. Cached for 60 s with single-flight; when SGDM
 * fails, the last answer is served for up to 10 minutes past its TTL, otherwise no key and the default cost apply
 * for a short failure window (15 s). Never throws and never logs the key.
 */
@Injectable()
export class ResearchConfigService {
  private readonly logger = new Logger(ResearchConfigService.name);
  private readonly cache = new CachedFetch<ResearchConfig>({ ttlSeconds: cacheSeconds, staleSeconds: STALE_SECONDS, failureSeconds: sgdmFailureSeconds });

  async get(): Promise<ResearchConfig> {
    if (!sgdmIntegrationEnabled()) return fallback();
    try {
      const value = await this.cache.get(KEY, () => this.load(), (error, servedStale) => {
        // SgdmIntegration errors never carry the integration key; the parsed body is never logged.
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(servedStale
          ? 'SGDM indisponível ao consultar a configuração da pesquisa; usando a última resposta (' + reason + ').'
          : 'SGDM indisponível ao consultar a configuração da pesquisa; seguindo sem chave de pesquisa (' + reason + ').');
      });
      return { ...value };
    } catch {
      return fallback();
    }
  }

  private async load(): Promise<ResearchConfig> {
    try {
      return parse(await sgdmIntegrationGet<unknown>('/integracoes/i7ai/pesquisa'));
    } catch (error) {
      if (error instanceof SgdmNotFound) return fallback(); // definitive: nothing configured
      throw error;
    }
  }
}
