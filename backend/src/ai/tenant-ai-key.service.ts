import { Injectable, Logger } from '@nestjs/common';
import { sgdmFailureSeconds } from '../sgdm/cached-fetch';
import { SgdmNotFound, SgdmUnavailable, sgdmIntegrationEnabled, sgdmIntegrationGet } from '../sgdm/sgdm-integration';

type TenantKey = { provider: string; apiKey: string } | null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CACHE = 1000;

/**
 * The prefeitura's own AI key is managed in SGDM (Cadastros › IA) and read through
 * SGDM's server-to-server endpoint. It is kept only in memory for a few minutes and
 * sent to the gateway with each request of a model from the same provider. Without
 * it, the gateway uses the platform key registered by SUPER_ADMIN, if any.
 */
@Injectable()
export class TenantAiKeyService {
  private readonly logger = new Logger(TenantAiKeyService.name);
  private readonly cache = new Map<string, { expires: number; key: TenantKey }>();

  enabled(env: NodeJS.ProcessEnv = process.env) {
    return sgdmIntegrationEnabled(env);
  }

  /** Key for this tenant when the model belongs to the provider configured in SGDM. */
  async forModel(tenantId: string, modelSlug: string): Promise<string | undefined> {
    if (!this.enabled() || !UUID.test(tenantId)) return undefined;
    const key = await this.load(tenantId);
    return key && modelSlug.toLowerCase().startsWith(key.provider + '/') ? key.apiKey : undefined;
  }

  private async load(tenantId: string): Promise<TenantKey> {
    const now = Date.now();
    const hit = this.cache.get(tenantId);
    if (hit && hit.expires > now) return hit.key;
    const { key, failed } = await this.fetchKey(tenantId);
    // A failed read (SGDM down/timeout) is remembered only briefly, so the prefeitura's own key comes back quickly.
    const seconds = failed ? sgdmFailureSeconds() : Math.max(0, Number(process.env.SGDM_AI_KEY_CACHE_SECONDS ?? 300));
    const ttl = seconds * 1000;
    if (ttl > 0) {
      if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(tenantId, { expires: now + ttl, key });
    }
    return key;
  }

  private async fetchKey(tenantId: string): Promise<{ key: TenantKey; failed: boolean }> {
    let body: { habilitado?: unknown; provedor?: unknown; apiKey?: unknown };
    try {
      body = await sgdmIntegrationGet<typeof body>('/integracoes/i7ai/ia/' + tenantId);
    } catch (error) {
      const status = error instanceof SgdmNotFound ? 404 : error instanceof SgdmUnavailable ? error.status : undefined;
      if (status) this.logger.warn('SGDM não forneceu a configuração de IA da prefeitura (HTTP ' + status + ').');
      else this.logger.warn('SGDM não respondeu à consulta da configuração de IA da prefeitura.');
      return { key: null, failed: !(error instanceof SgdmNotFound) };
    }
    if (body?.habilitado !== true || typeof body.provedor !== 'string' || typeof body.apiKey !== 'string' || !body.apiKey.trim() || /\s/.test(body.apiKey.trim())) return { key: null, failed: false };
    return { key: { provider: body.provedor.toLowerCase(), apiKey: body.apiKey.trim() }, failed: false };
  }
}
