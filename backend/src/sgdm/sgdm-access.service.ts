import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SgdmNotFound, sgdmIntegrationEnabled, sgdmIntegrationGet } from './sgdm-integration';

export type AllowedModels = { slugs: string[]; defaultSlug: string | null };
type Entry = { expires: number; staleUntil: number; value: AllowedModels };

const MAX_CACHE = 5000;
const STALE_SECONDS = 600;
const NOT_CONFIRMED = 'Não foi possível confirmar os modelos liberados para você. Tente novamente em instantes.';
const NOT_ALLOWED = 'Este modelo não está liberado para você. Escolha outro no seletor do chat.';

/** SGDM_ACCESS_CACHE_SECONDS; empty, invalid or negative values fall back to 60. */
function cacheSeconds() {
  const raw = process.env.SGDM_ACCESS_CACHE_SECONDS?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : 60;
}

/**
 * Models a user (or, for automations, the whole prefeitura) may use, as released in SGDM's Central de IA.
 * Kept in a short cache; when SGDM is down the last answer is served for up to 10 minutes past its TTL,
 * and with no answer at all the request fails closed (never "everything allowed").
 */
@Injectable()
export class SgdmAccessService {
  private readonly logger = new Logger(SgdmAccessService.name);
  private readonly cache = new Map<string, Entry>();

  /** null when the SGDM integration is off: standalone mode does not filter models. */
  async allowed(tenantId: string, userId?: string): Promise<AllowedModels | null> {
    if (!sgdmIntegrationEnabled()) return null;
    const key = tenantId + ':' + (userId || '-');
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.value;
    let value: AllowedModels;
    try {
      value = await this.fetch(tenantId, userId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (hit && hit.staleUntil > now) {
        this.logger.warn('SGDM indisponível ao consultar os modelos liberados; usando a última resposta (' + reason + ').');
        return hit.value;
      }
      this.logger.error('SGDM indisponível ao consultar os modelos liberados (' + reason + ').');
      throw new ServiceUnavailableException(NOT_CONFIRMED);
    }
    const ttl = cacheSeconds() * 1000;
    this.cache.delete(key);
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { expires: now + ttl, staleUntil: now + ttl + STALE_SECONDS * 1000, value });
    return value;
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
