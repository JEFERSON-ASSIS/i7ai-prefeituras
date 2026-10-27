import { Injectable, Logger } from '@nestjs/common';
import { SgdmNotFound, sgdmIntegrationEnabled, sgdmIntegrationGet } from './sgdm-integration';

/** A user's own AI limits, set in SGDM's Central de IA. null fields mean "no limit of that kind". */
export type UserLimits = { monthlyBudgetUsd: number | null; block: boolean; callsPerMinute: number | null; tokensPerMinute: number | null };
type Entry = { expires: number; staleUntil: number; value: UserLimits | null };

const MAX_CACHE = 5000;
const STALE_SECONDS = 600;

/** SGDM_LIMITS_CACHE_SECONDS; empty, invalid or negative values fall back to 60. */
function cacheSeconds() {
  const raw = process.env.SGDM_LIMITS_CACHE_SECONDS?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : 60;
}

const nullableNumber = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);

/** Validates SGDM's `{ usuario: LimiteUsuarioI7ai | null }`; anything else is treated as an outage. */
function parseLimits(body: unknown): UserLimits | null {
  const value = body as { usuario?: unknown } | null;
  if (!value || typeof value !== 'object' || !('usuario' in value)) throw new Error('resposta inválida do SGDM');
  if (value.usuario === null) return null;
  const limit = value.usuario as Record<string, unknown> | undefined;
  if (!limit || typeof limit !== 'object' || typeof limit.bloquear !== 'boolean'
    || !nullableNumber(limit.orcamentoMensalUsd) || !nullableNumber(limit.chamadasPorMinuto) || !nullableNumber(limit.tokensPorMinuto)) {
    throw new Error('resposta inválida do SGDM');
  }
  return { monthlyBudgetUsd: limit.orcamentoMensalUsd, block: limit.bloquear, callsPerMinute: limit.chamadasPorMinuto, tokensPerMinute: limit.tokensPorMinuto };
}

/**
 * Per-user AI limits read from SGDM. Cached briefly; when SGDM is down the last answer is served for up to
 * 10 minutes past its TTL, and after that the call goes on without a user limit (the prefeitura's own cap
 * still applies in LiteLLM). This is deliberately fail-open, unlike model access.
 */
@Injectable()
export class SgdmLimitsService {
  private readonly logger = new Logger(SgdmLimitsService.name);
  private readonly cache = new Map<string, Entry>();

  async forUser(tenantId: string, userId: string): Promise<UserLimits | null> {
    if (!sgdmIntegrationEnabled()) return null;
    const key = tenantId + ':' + userId;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.value;
    let value: UserLimits | null;
    try {
      value = parseLimits(await sgdmIntegrationGet<unknown>('/integracoes/i7ai/limites/' + encodeURIComponent(tenantId) + '?usuarioId=' + encodeURIComponent(userId)));
    } catch (error) {
      if (!(error instanceof SgdmNotFound)) {
        // SgdmIntegration errors never carry the integration key.
        const reason = error instanceof Error ? error.message : String(error);
        if (hit && hit.staleUntil > now) {
          this.logger.warn('SGDM indisponível ao consultar os limites de IA do usuário; usando a última resposta (' + reason + ').');
          return hit.value;
        }
        this.logger.warn('SGDM indisponível ao consultar os limites de IA do usuário ' + userId + ' (prefeitura ' + tenantId + '); seguindo sem limite do usuário (' + reason + ').');
        return null;
      }
      // A definitive answer (unknown tenant/user): cached as "no user limit" like SgdmAccessService,
      // logged once per new cache entry instead of on every paid round.
      this.logger.warn('SGDM respondeu 404 ao consultar os limites de IA (prefeitura ' + tenantId + ', usuário ' + userId + '); seguindo sem limite do usuário.');
      value = null;
    }
    const ttl = cacheSeconds() * 1000;
    this.cache.delete(key);
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { expires: now + ttl, staleUntil: now + ttl + STALE_SECONDS * 1000, value });
    return value;
  }
}
