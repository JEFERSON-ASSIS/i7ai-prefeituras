import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { CachedFetch, envSeconds, sgdmFailureSeconds } from './cached-fetch';
import { SgdmNotFound, sgdmIntegrationEnabled, sgdmIntegrationGet } from './sgdm-integration';

export type AllowedModels = { slugs: string[]; defaultSlug: string | null };

const STALE_SECONDS = 600;
const NOT_CONFIRMED = 'Não foi possível confirmar os modelos liberados para você. Tente novamente em instantes.';
const NOT_ALLOWED = 'Este modelo não está liberado para você. Escolha outro no seletor do chat.';

/** SGDM_ACCESS_CACHE_SECONDS; empty, invalid or negative values fall back to 60. */
const cacheSeconds = () => envSeconds('SGDM_ACCESS_CACHE_SECONDS', 60);

/**
 * Models a user (or, for automations, the whole prefeitura) may use, as released in SGDM's Central de IA.
 * Kept in a short cache; when SGDM is down the last answer is served for up to 10 minutes past its TTL,
 * and with no answer at all the request fails closed (never "everything allowed").
 */
@Injectable()
export class SgdmAccessService {
  private readonly logger = new Logger(SgdmAccessService.name);
  private readonly cache = new CachedFetch<AllowedModels>({ ttlSeconds: cacheSeconds, staleSeconds: STALE_SECONDS, failureSeconds: sgdmFailureSeconds });

  /** null when the SGDM integration is off: standalone mode does not filter models. */
  async allowed(tenantId: string, userId?: string): Promise<AllowedModels | null> {
    if (!sgdmIntegrationEnabled()) return null;
    try {
      return await this.cache.get(tenantId + ':' + (userId || '-'), () => this.fetch(tenantId, userId), (error, servedStale) => {
        const reason = error instanceof Error ? error.message : String(error);
        if (servedStale) this.logger.warn('SGDM indisponível ao consultar os modelos liberados; usando a última resposta (' + reason + ').');
        else this.logger.error('SGDM indisponível ao consultar os modelos liberados (' + reason + ').');
      });
    } catch {
      // Fail closed: no usable value, so never "everything allowed". Repeats within the failure window skip SGDM.
      throw new ServiceUnavailableException(NOT_CONFIRMED);
    }
  }

  async assertAllowed(tenantId: string, userId: string | undefined, slug: string): Promise<void> {
    const allowed = await this.allowed(tenantId, userId);
    if (allowed && !allowed.slugs.includes(slug)) throw new ForbiddenException(NOT_ALLOWED);
  }

  private async fetch(tenantId: string, userId?: string): Promise<AllowedModels> {
    const path = '/integracoes/i7ai/acesso/' + encodeURIComponent(tenantId) + (userId ? '?usuarioId=' + encodeURIComponent(userId) : '');
    let body: { modelos?: unknown; padrao?: unknown };
    try {
      body = await sgdmIntegrationGet<{ modelos?: unknown; padrao?: unknown }>(path);
    } catch (error) {
      // A definitive "unknown tenant/user" closes access instead of being retried as an outage.
      if (error instanceof SgdmNotFound) {
        // Logged once per new cache entry so a misconfigured SGDM (e.g. integration key unset there) is visible.
        this.logger.warn('SGDM respondeu 404 ao consultar os modelos liberados (prefeitura ' + tenantId + (userId ? ', usuário ' + userId : '') + '); nenhum modelo liberado.');
        return { slugs: [], defaultSlug: null };
      }
      throw error;
    }
    const { modelos, padrao } = body ?? {};
    if (!Array.isArray(modelos) || !modelos.every(item => typeof item === 'string') || (padrao !== null && padrao !== undefined && typeof padrao !== 'string')) {
      throw new Error('resposta inválida do SGDM');
    }
    return { slugs: modelos as string[], defaultSlug: typeof padrao === 'string' ? padrao : null };
  }
}
