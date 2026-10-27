import { Injectable, Logger } from '@nestjs/common';
import { CachedFetch, envSeconds, sgdmFailureSeconds } from './cached-fetch';
import { SgdmNotFound, sgdmIntegrationEnabled, sgdmIntegrationGet } from './sgdm-integration';

/** A user's own AI limits, set in SGDM's Central de IA. null fields mean "no limit of that kind". */
export type UserLimits = { monthlyBudgetUsd: number | null; block: boolean; callsPerMinute: number | null; tokensPerMinute: number | null };

const STALE_SECONDS = 600;

/** SGDM_LIMITS_CACHE_SECONDS; empty, invalid or negative values fall back to 60. */
const cacheSeconds = () => envSeconds('SGDM_LIMITS_CACHE_SECONDS', 60);

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
 * still applies in LiteLLM). This is deliberately fail-open, unlike model access. A failed read is remembered
 * for a short window (SGDM_FAILURE_CACHE_SECONDS) so paid rounds never wait on the SGDM timeout again, and
 * concurrent callers share one fetch.
 */
@Injectable()
export class SgdmLimitsService {
  private readonly logger = new Logger(SgdmLimitsService.name);
  private readonly cache = new CachedFetch<UserLimits | null>({ ttlSeconds: cacheSeconds, staleSeconds: STALE_SECONDS, failureSeconds: sgdmFailureSeconds });

  async forUser(tenantId: string, userId: string): Promise<UserLimits | null> {
    if (!sgdmIntegrationEnabled()) return null;
    try {
      return await this.cache.get(tenantId + ':' + userId, () => this.load(tenantId, userId), (error, servedStale) => {
        // SgdmIntegration errors never carry the integration key.
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(servedStale
          ? 'SGDM indisponível ao consultar os limites de IA do usuário; usando a última resposta (' + reason + ').'
          : 'SGDM indisponível ao consultar os limites de IA do usuário ' + userId + ' (prefeitura ' + tenantId + '); seguindo sem limite do usuário (' + reason + ').');
      });
    } catch {
      return null; // fail open; logged once when it happened, then remembered for the failure window
    }
  }

  private async load(tenantId: string, userId: string): Promise<UserLimits | null> {
    try {
      return parseLimits(await sgdmIntegrationGet<unknown>('/integracoes/i7ai/limites/' + encodeURIComponent(tenantId) + '?usuarioId=' + encodeURIComponent(userId)));
    } catch (error) {
      if (!(error instanceof SgdmNotFound)) throw error;
      // A definitive answer (unknown tenant/user): cached as "no user limit" like SgdmAccessService,
      // logged once per new cache entry instead of on every paid round.
      this.logger.warn('SGDM respondeu 404 ao consultar os limites de IA (prefeitura ' + tenantId + ', usuário ' + userId + '); seguindo sem limite do usuário.');
      return null;
    }
  }
}
