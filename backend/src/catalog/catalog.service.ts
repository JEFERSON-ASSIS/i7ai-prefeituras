import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LicenseDto } from './catalog.dto';
import { publicModelCapabilities } from './model-capabilities';
import { SgdmAccessService } from '../sgdm/sgdm-access.service';
import { DEFAULT_TIMEZONE } from './tenant-settings';

const userSelect = {
  id: true, tenantId: true, departmentId: true, name: true, email: true, status: true,
  lastAccessAt: true, createdAt: true, updatedAt: true, department: true,
  roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
} satisfies Prisma.UserSelect;

function largeInteger(value: string | undefined, field: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,19}$/.test(value) || BigInt(value) > 9223372036854775807n) throw new BadRequestException(`${field} deve ser um inteiro positivo`);
  return BigInt(value);
}

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

  departments(tenantId: string) {
    return this.prisma.department.findMany({ where: { tenantId }, include: { _count: { select: { users: true, agents: true } } }, orderBy: { name: 'asc' } });
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

  async licensing(tenantId: string) {
    const [license, users, agents, automations, knowledgeBases, storage, usage] = await Promise.all([
      this.prisma.license.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.user.count({ where: { tenantId, status: { not: 'SUSPENDED' } } }), this.prisma.agent.count({ where: { tenantId, status: { not: 'ARCHIVED' } } }),
      this.prisma.automation.count({ where: { tenantId, status: { not: 'ARCHIVED' } } }), this.prisma.knowledgeBase.count({ where: { tenantId } }),
      this.prisma.document.aggregate({ where: { tenantId }, _sum: { sizeBytes: true } }),
      this.prisma.aiUsage.aggregate({ where: { tenantId, createdAt: { gte: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)) } }, _sum: { inputTokens: true, outputTokens: true } }),
    ]);
    const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const from = license && license.startDate > month ? license.startDate : month;
    const reservations = await this.prisma.aiTokenReservation.aggregate({ where: { tenantId, createdAt: { gte: from }, status: { in: ['RESERVED', 'UNCERTAIN'] } }, _sum: { reservedTokens: true } });
    return { license: license ? { ...license, maxStorageBytes: license.maxStorageBytes.toString(), maxTokens: license.maxTokens.toString() } : null,
      usage: { users, agents, automations, knowledgeBases, reservedTokens: (reservations._sum.reservedTokens || 0n).toString(), storageBytes: (storage._sum.sizeBytes ?? 0n).toString(), tokensThisMonth: (BigInt(usage._sum.inputTokens ?? 0) + BigInt(usage._sum.outputTokens ?? 0)).toString() } };
  }

  async updateLicense(tenantId: string, input: LicenseDto, actorId: string) {
    if (!await this.prisma.userRole.findFirst({ where: { userId: actorId, user: { tenantId, status: 'ACTIVE' }, role: { name: 'SUPER_ADMIN' } } })) throw new ForbiddenException('Somente SUPER_ADMIN pode alterar limites de licença');
    if (input.features && Object.values(input.features).some((value) => typeof value !== 'boolean')) throw new BadRequestException('Recursos devem ser booleanos');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`);
      const existing = await tx.license.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
      const startDate = input.startDate ? new Date(input.startDate) : existing?.startDate;
      const endDate = input.endDate === null ? null : input.endDate ? new Date(input.endDate) : existing?.endDate;
      if (startDate && endDate && endDate <= startDate) throw new BadRequestException('Fim da licença deve ser posterior ao início');
      const data = { status: input.status, startDate, endDate, maxUsers: input.maxUsers, maxAgents: input.maxAgents, maxAutomations: input.maxAutomations, maxKnowledgeBases: input.maxKnowledgeBases,
        maxStorageBytes: largeInteger(input.maxStorageBytes, 'maxStorageBytes'), maxTokens: largeInteger(input.maxTokens, 'maxTokens'), features: input.features as Prisma.InputJsonObject | undefined };
      const license = existing ? await tx.license.update({ where: { id: existing.id }, data }) : await tx.license.create({ data: { tenantId, ...data } });
      await tx.auditLog.create({ data: { tenantId, userId: actorId, event: existing ? 'license.updated' : 'license.created', resource: 'licensing', resourceId: license.id, metadata: { status: license.status } } });
    });
    return this.licensing(tenantId);
  }
}
