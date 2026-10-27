import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { publicModelCapabilities } from './model-capabilities';
import { SgdmAccessService } from '../sgdm/sgdm-access.service';
import { DEFAULT_TIMEZONE } from './tenant-settings';

const userSelect = {
  id: true, tenantId: true, departmentId: true, name: true, email: true, status: true,
  lastAccessAt: true, createdAt: true, updatedAt: true, department: true,
  roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
} satisfies Prisma.UserSelect;

function providerMetadata(provider: { id: string; name: string; slug: string; config?: Prisma.JsonValue }) {
  const config = provider.config && typeof provider.config === 'object' && !Array.isArray(provider.config) ? provider.config as Record<string, unknown> : {};
  const directIntegration = provider.slug.toLowerCase() === 'openai';
  const omniRouter = Boolean(process.env.OMNIROUTER_BASE_URL || process.env.OMNIROUTER_API_KEY);
  const omniRouterConfigured = Boolean(process.env.OMNIROUTER_BASE_URL && process.env.OMNIROUTER_API_KEY);
  const gatewayIntegration = omniRouter || Boolean(process.env.AI_GATEWAY_URL);
  return { id: provider.id, name: provider.name, slug: provider.slug, capabilities: {
    supported: directIntegration || gatewayIntegration, directIntegration, gatewayIntegration,
    integrationConfigured: omniRouter ? omniRouterConfigured : gatewayIntegration || (directIntegration && Boolean(process.env.OPENAI_API_KEY)),
    credentialsConfigured: omniRouter ? Boolean(process.env.OMNIROUTER_API_KEY) : gatewayIntegration ? Boolean(process.env.AI_GATEWAY_API_KEY) : directIntegration && Boolean(process.env.OPENAI_API_KEY),
    // Adapter support for the user-facing control, distinct from internal model reasoning.
    supportsAdvancedReasoningControl: !omniRouter && (directIntegration || gatewayIntegration),
    supportsReasoning: typeof config.supportsReasoning === 'boolean' ? config.supportsReasoning : null,
    supportsTemperature: typeof config.supportsTemperature === 'boolean' ? config.supportsTemperature : null,
  } };
}

const modelInclude = { provider: { select: { id: true, name: true, slug: true } }, _count: { select: { agents: true } } } satisfies Prisma.AiModelInclude;
function serializeModel(model: Prisma.AiModelGetPayload<{ include: typeof modelInclude }>) {
  return { ...model, provider: providerMetadata(model.provider), capabilities: publicModelCapabilities(model.capabilities), inputPrice: model.inputPrice === null ? null : Number(model.inputPrice), outputPrice: model.outputPrice === null ? null : Number(model.outputPrice) };
}

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService, private readonly access?: SgdmAccessService) {}

  /**
   * Read-only: with the SGDM integration, settings are the prefeitura's (settingsFromSgdm, written on login)
   * and defaultModelId is the prefeitura's released default model. Standalone mode keeps the stored values.
   */
  async settings(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true, settings: true } });
    if (!tenant) throw new NotFoundException('Prefeitura não encontrada');
    const raw = tenant.settings && typeof tenant.settings === 'object' && !Array.isArray(tenant.settings) ? tenant.settings : {};
    const allowed = ['organizationName', 'timezone', 'locale', 'defaultModelId', 'theme', 'retentionDays', 'allowSignups'];
    const settings: Record<string, unknown> = { timezone: DEFAULT_TIMEZONE, locale: 'pt-BR', theme: 'system', ...Object.fromEntries(Object.entries(raw).filter(([key]) => allowed.includes(key))) };
    let released: Awaited<ReturnType<SgdmAccessService['allowed']>> | undefined;
    // SGDM down with nothing cached must not take the read-only settings page down with it.
    try { released = await this.access?.allowed(tenantId); } catch { released = undefined; }
    if (released !== null && this.access) {
      const model = released?.defaultSlug ? await this.prisma.aiModel.findFirst({ where: { slug: released.defaultSlug, active: true }, select: { id: true } }) : null;
      settings.defaultModelId = model?.id ?? null;
    }
    return { ...tenant, settings };
  }

  /** Active departments only; `includeId` (the agent's current department) is also returned, with its `status`, so an edit can show it as inactive. */
  departments(tenantId: string, includeId?: string) {
    return this.prisma.department.findMany({ where: { tenantId, OR: [{ status: 'ACTIVE' }, ...(includeId ? [{ id: includeId }] : [])] }, include: { _count: { select: { users: true, agents: true } } }, orderBy: { name: 'asc' } });
  }
  /** Read-only catalog: the SGDM Central de IA decides which models are active and released to whom. */
  async models(actor: { sub: string; tenantId: string; roles: string[] }) {
    const models = await this.activeModels();
    if (actor.roles.includes('SUPER_ADMIN')) return models;
    const allowed = await this.access?.allowed(actor.tenantId, actor.sub);
    return allowed ? models.filter(model => allowed.slugs.includes(model.slug)) : models;
  }
  async activeModels() {
    const models = await this.prisma.aiModel.findMany({ where: { active: true }, include: modelInclude, orderBy: [{ provider: { name: 'asc' } }, { name: 'asc' }] });
    return models.map(serializeModel);
  }
  async providers() {
    const providers = await this.prisma.aiProvider.findMany({ select: { id: true, name: true, slug: true, config: true }, orderBy: { name: 'asc' } });
    return providers.map(providerMetadata);
  }
  users(tenantId: string) { return this.prisma.user.findMany({ where: { tenantId }, select: userSelect, orderBy: { name: 'asc' } }); }
  roles() { return this.prisma.role.findMany({ include: { permissions: { include: { permission: true } } }, orderBy: { name: 'asc' } }); }
}
