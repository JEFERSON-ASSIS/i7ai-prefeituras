import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { litellmAdmin, litellmCall, litellmErrorMessage } from './litellm-admin';

// Names must match `litellm_credential_name` in deploy/litellm/config.yaml.
export const CREDENTIAL_PROVIDERS = [
  { provider: 'openai', name: 'OpenAI' },
  { provider: 'anthropic', name: 'Anthropic (Claude)' },
  { provider: 'gemini', name: 'Google Gemini' },
] as const;

type Actor = { sub: string; tenantId: string; roles: string[] };
type GatewayCredential = { credential_name?: unknown; credential_values?: { api_key?: unknown } };

/**
 * Provider API keys managed by SUPER_ADMIN and stored encrypted by LiteLLM.
 * The raw key only passes through this request: it is never stored, logged,
 * audited or returned by the i7Ai.
 */
@Injectable()
export class ProviderCredentialsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: Actor) {
    this.requireSuperAdmin(actor);
    const payload = await this.call('GET', '/credentials') as { credentials?: GatewayCredential[] };
    const stored = new Map((payload.credentials || []).map(item => [String(item.credential_name), item]));
    return CREDENTIAL_PROVIDERS.map(({ provider, name }) => {
      const masked = stored.get(provider)?.credential_values?.api_key;
      return { provider, name, configured: stored.has(provider), maskedKey: typeof masked === 'string' ? masked : null };
    });
  }

  async save(actor: Actor, provider: string, apiKey: unknown) {
    this.requireSuperAdmin(actor);
    this.requireProvider(provider);
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (key.length < 20 || key.length > 512 || /\s/.test(key)) throw new BadRequestException('Informe uma chave de API válida, sem espaços.');
    const body = { credential_info: { custom_llm_provider: provider }, credential_values: { api_key: key } };
    const exists = await this.call('GET', '/credentials/by_name/' + provider, undefined, true);
    if (exists === null) await this.call('POST', '/credentials', { credential_name: provider, ...body });
    else await this.call('PATCH', '/credentials/' + provider, body);
    await this.audit(actor, 'ai.credential.saved', provider);
    return (await this.list(actor)).find(item => item.provider === provider);
  }

  async remove(actor: Actor, provider: string) {
    this.requireSuperAdmin(actor);
    this.requireProvider(provider);
    await this.call('DELETE', '/credentials/' + provider, undefined, true);
    await this.audit(actor, 'ai.credential.removed', provider);
    return { provider, configured: false };
  }

  /** Sends a few-token request through the gateway to confirm the key works. */
  async test(actor: Actor, provider: string) {
    this.requireSuperAdmin(actor);
    this.requireProvider(provider);
    // Use a model the gateway actually serves for this provider (config.yaml).
    const served = await this.call('GET', '/v1/models') as { data?: { id?: unknown }[] };
    const slug = (served.data || []).map(item => String(item.id)).find(id => id.startsWith(provider + '/') && !id.includes('*'));
    if (!slug) throw new BadRequestException('Nenhum modelo deste provedor está configurado no gateway de IA (deploy/litellm/config.yaml).');
    const model = { slug };
    const { base, key } = litellmAdmin();
    let response: Response;
    try {
      response = await fetch(base + '/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: model.slug, messages: [{ role: 'user', content: 'Responda apenas: ok' }], max_tokens: 5 }),
      });
    } catch {
      throw new ServiceUnavailableException('O gateway de IA não respondeu. Verifique se o LiteLLM está em execução.');
    }
    if (response.ok) return { ok: true, model: model.slug, message: 'A chave respondeu corretamente.' };
    return { ok: false, model: model.slug, message: await litellmErrorMessage(response) };
  }

  private requireSuperAdmin(actor: Actor) {
    if (!actor.roles.includes('SUPER_ADMIN')) throw new ForbiddenException('Somente SUPER_ADMIN pode gerenciar as chaves dos provedores de IA.');
  }

  private requireProvider(provider: string) {
    if (!CREDENTIAL_PROVIDERS.some(item => item.provider === provider)) throw new BadRequestException('Provedor de IA não suportado.');
  }

  private call(method: string, path: string, body?: unknown, allowNotFound = false) {
    return litellmCall(method, path, body, allowNotFound);
  }

  private audit(actor: Actor, event: string, provider: string) {
    return this.prisma.auditLog.create({ data: { tenantId: actor.tenantId, userId: actor.sub, event, resource: 'ai-credentials', resourceId: provider, metadata: { provider } } });
  }
}
