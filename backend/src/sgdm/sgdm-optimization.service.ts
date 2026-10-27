import { Injectable, Logger } from '@nestjs/common';
import { SgdmNotFound, sgdmIntegrationEnabled, sgdmIntegrationGet } from './sgdm-integration';
import { OPTIMIZATION_DEFAULTS, OtimizacaoEfetiva, OtimizacaoI7ai } from './optimization-defaults';

type Entry = { expires: number; staleUntil: number; value: OtimizacaoI7ai | null };

const MAX_CACHE = 5000;
const STALE_SECONDS = 600;

function seconds(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
/** SGDM_OPTIMIZATION_CACHE_SECONDS; empty, invalid or negative values fall back to 60. */
const cacheSeconds = () => seconds('SGDM_OPTIMIZATION_CACHE_SECONDS', 60);
/** SGDM_OPTIMIZATION_FAILURE_CACHE_SECONDS: how long a failed read is remembered before SGDM is retried (default 15). */
const failureSeconds = () => seconds('SGDM_OPTIMIZATION_FAILURE_CACHE_SECONDS', 15);

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const bool = (value: unknown) => typeof value === 'boolean';
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const model = (value: unknown) => value === null || typeof value === 'string';

/** Checks one `OtimizacaoEfetiva`; anything off-contract is treated as an outage, never half-applied. */
function validEffective(value: unknown): value is OtimizacaoEfetiva {
  if (!record(value)) return false;
  const { modeloCaro, cachePrompt, resumoHistorico, cacheExato, limiteSaida, imagensBaixa, sugestoes } = value;
  return record(modeloCaro) && bool(modeloCaro.ligado) && num(modeloCaro.fatorPreco) && num(modeloCaro.saidaCurta)
    && record(cachePrompt) && bool(cachePrompt.ligado)
    && record(resumoHistorico) && bool(resumoHistorico.ligado) && num(resumoHistorico.mensagens) && record(resumoHistorico.modelos)
    && model(resumoHistorico.modelos.openai) && model(resumoHistorico.modelos.anthropic) && model(resumoHistorico.modelos.gemini)
    && record(cacheExato) && bool(cacheExato.ligado) && num(cacheExato.ttlSegundos) && bool(cacheExato.chat)
    && record(limiteSaida) && bool(limiteSaida.ligado) && (limiteSaida.tokens === null || (Number.isSafeInteger(limiteSaida.tokens) && (limiteSaida.tokens as number) >= 1))
    && record(imagensBaixa) && bool(imagensBaixa.ligado)
    && record(sugestoes) && bool(sugestoes.ligado) && num(sugestoes.minimoUsd)
    && (value.pesquisaInternet === undefined || (record(value.pesquisaInternet) && bool(value.pesquisaInternet.ligado)));
}

/** An older SGDM may not send `pesquisaInternet` yet: web search stays off (the default). */
const withSearch = (value: OtimizacaoEfetiva): OtimizacaoEfetiva => ({ ...value, pesquisaInternet: value.pesquisaInternet ?? { ligado: false } });

function parseOptimizations(body: unknown): OtimizacaoI7ai {
  if (!record(body) || !validEffective(body.padrao) || !record(body.agentes) || !Object.values(body.agentes).every(validEffective)) {
    throw new Error('resposta inválida do SGDM');
  }
  return {
    padrao: withSearch(body.padrao),
    agentes: Object.fromEntries(Object.entries(body.agentes as Record<string, OtimizacaoEfetiva>).map(([id, own]) => [id, withSearch(own)])),
  };
}

const copy = (value: OtimizacaoEfetiva): OtimizacaoEfetiva => structuredClone(value);

/**
 * Optimization settings set in SGDM's Central de IA, resolved there (agent > prefeitura > todos > padrão).
 * Cached per prefeitura; when SGDM is down the last answer is served for up to 10 minutes past its TTL,
 * and after that (or when it was never read) the defaults apply. Never throws: unlike model access, a
 * missing configuration must never block the chat. During an outage a failed read is remembered for a short
 * window (no new SGDM call, so chats never wait on the timeout again), and concurrent callers share one fetch.
 */
@Injectable()
export class SgdmOptimizationService {
  private readonly logger = new Logger(SgdmOptimizationService.name);
  private readonly cache = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<OtimizacaoI7ai | null>>();

  async effective(tenantId: string, agentId: string): Promise<OtimizacaoEfetiva> {
    const all = await this.forTenant(tenantId);
    if (!all) return copy(OPTIMIZATION_DEFAULTS);
    const own = Object.prototype.hasOwnProperty.call(all.agentes, agentId) ? all.agentes[agentId] : undefined;
    return copy(own ?? all.padrao);
  }

  private async forTenant(tenantId: string): Promise<OtimizacaoI7ai | null> {
    if (!sgdmIntegrationEnabled()) return null;
    const now = Date.now();
    const hit = this.cache.get(tenantId);
    if (hit && hit.expires > now) return hit.value;
    const pending = this.inFlight.get(tenantId);
    if (pending) return pending;
    const request = this.fetch(tenantId, hit).finally(() => this.inFlight.delete(tenantId));
    this.inFlight.set(tenantId, request);
    return request;
  }

  private async fetch(tenantId: string, hit: Entry | undefined): Promise<OtimizacaoI7ai | null> {
    let value: OtimizacaoI7ai | null;
    try {
      value = parseOptimizations(await sgdmIntegrationGet<unknown>('/integracoes/i7ai/otimizacoes/' + encodeURIComponent(tenantId)));
    } catch (error) {
      if (!(error instanceof SgdmNotFound)) {
        // SgdmIntegration errors never carry the integration key.
        const reason = error instanceof Error ? error.message : String(error);
        const failedAt = Date.now(); const retryAt = failedAt + failureSeconds() * 1000;
        if (hit && hit.staleUntil > failedAt) {
          this.logger.warn('SGDM indisponível ao consultar as otimizações de IA; usando a última resposta (' + reason + ').');
          // Serve the stale value without retrying SGDM until the failure window ends (never past staleUntil).
          hit.expires = Math.min(retryAt, hit.staleUntil);
          return hit.value;
        }
        this.logger.warn('SGDM indisponível ao consultar as otimizações de IA da prefeitura ' + tenantId + '; usando os padrões (' + reason + ').');
        // Negative cache: defaults until the failure window ends, then one retry.
        this.store(tenantId, { expires: retryAt, staleUntil: retryAt, value: null });
        return null;
      }
      // A definitive answer (unknown tenant): cached as "defaults" and logged once per cache entry.
      this.logger.warn('SGDM respondeu 404 ao consultar as otimizações de IA (prefeitura ' + tenantId + '); usando os padrões.');
      value = null;
    }
    const now = Date.now(); const ttl = cacheSeconds() * 1000;
    this.store(tenantId, { expires: now + ttl, staleUntil: now + ttl + STALE_SECONDS * 1000, value });
    return value;
  }

  private store(tenantId: string, entry: Entry) {
    this.cache.delete(tenantId);
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(tenantId, entry);
  }
}
