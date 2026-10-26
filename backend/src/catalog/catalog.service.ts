import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateModelDto, CreateUserDto, DepartmentDto, LicenseDto, SettingsDto, UpdateDepartmentDto, UpdateModelDto, UpdateUserDto } from './catalog.dto';
import { assertLicenseCapacity } from './license-policy';
import { publicModelCapabilities } from './model-capabilities';
import { gatewayRoutingActive, isAllowedRoute, routePolicyMessage } from './model-route-policy';

const userSelect = {
  id: true, tenantId: true, departmentId: true, name: true, email: true, status: true,
  lastAccessAt: true, createdAt: true, updatedAt: true, department: true,
  roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
} satisfies Prisma.UserSelect;

function conflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Este nome ou e-mail já está cadastrado');
  throw error;
}
function largeInteger(value: string | undefined, field: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,19}$/.test(value) || BigInt(value) > 9223372036854775807n) throw new BadRequestException(`${field} deve ser um inteiro positivo`);
  return BigInt(value);
}

export function validateModelPrice(value: unknown, field: string): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 9999.999999 || Math.round(value * 1_000_000) / 1_000_000 !== value) {
    throw new BadRequestException(`${field} deve ser um preço em USD por milhão de tokens entre 0 e 9999.999999, com até 6 casas decimais`);
  }
  return value;
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
  constructor(private readonly prisma: PrismaService) {}

  async settings(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true, settings: true } });
    if (!tenant) throw new NotFoundException('Prefeitura não encontrada');
    const raw = tenant.settings && typeof tenant.settings === 'object' && !Array.isArray(tenant.settings) ? tenant.settings : {};
    const allowed = ['organizationName', 'timezone', 'locale', 'defaultModelId', 'theme', 'retentionDays', 'allowSignups'];
    const settings = Object.fromEntries(Object.entries(raw).filter(([key]) => allowed.includes(key)));
    return { ...tenant, settings: { timezone: 'America/Cuiaba', locale: 'pt-BR', theme: 'system', ...settings } };
  }

  async updateSettings(tenantId: string, input: SettingsDto, actorId?: string) {
    if (input.timezone) { try { new Intl.DateTimeFormat('pt-BR', { timeZone: input.timezone }); } catch { throw new BadRequestException('Fuso horário inválido'); } }
    if (input.defaultModelId && !await this.prisma.aiModel.findUnique({ where: { id: input.defaultModelId } })) throw new BadRequestException('Modelo não encontrado');
    await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) throw new NotFoundException('Prefeitura não encontrada');
      const previous = tenant.settings && typeof tenant.settings === 'object' && !Array.isArray(tenant.settings) ? tenant.settings : {};
      await tx.tenant.update({ where: { id: tenantId }, data: { settings: { ...previous, ...input } as Prisma.InputJsonObject } });
      await tx.auditLog.create({ data: { tenantId, userId: actorId, event: 'settings.updated', resource: 'settings', resourceId: tenantId, metadata: { fields: Object.keys(input) } } });
    });
    return this.settings(tenantId);
  }

  departments(tenantId: string) {
    return this.prisma.department.findMany({ where: { tenantId }, include: { _count: { select: { users: true, agents: true } } }, orderBy: { name: 'asc' } });
  }
  async createDepartment(tenantId: string, input: DepartmentDto, actorId?: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const department = await tx.department.create({ data: { tenantId, name: input.name.trim(), description: input.description, status: input.status ?? 'ACTIVE' } });
        await tx.auditLog.create({ data: { tenantId, userId: actorId, event: 'department.created', resource: 'departments', resourceId: department.id, metadata: { status: department.status } } });
        return department;
      });
    } catch (error) { conflict(error); }
  }
  async updateDepartment(tenantId: string, id: string, input: UpdateDepartmentDto, actorId?: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (!await tx.department.findFirst({ where: { id, tenantId } })) throw new NotFoundException('Departamento não encontrado');
        const department = await tx.department.update({ where: { id }, data: { name: input.name?.trim(), description: input.description, status: input.status } });
        await tx.auditLog.create({ data: { tenantId, userId: actorId, event: 'department.updated', resource: 'departments', resourceId: department.id, metadata: { status: department.status } } });
        return department;
      });
    } catch (error) { conflict(error); }
  }
  async models() {
    const models = await this.prisma.aiModel.findMany({ include: modelInclude, orderBy: [{ provider: { name: 'asc' } }, { name: 'asc' }] });
    return models.map(serializeModel);
  }
  async providers() {
    const providers = await this.prisma.aiProvider.findMany({ select: { id: true, name: true, slug: true, config: true }, orderBy: { name: 'asc' } });
    return providers.map(providerMetadata);
  }
  private async requireSupportedProvider(tx: Prisma.TransactionClient, providerId: string) {
    const provider = await tx.aiProvider.findUnique({ where: { id: providerId }, select: { id: true, name: true, slug: true } });
    if (!provider) throw new BadRequestException('Provedor não encontrado no catálogo');
    if (!providerMetadata(provider).capabilities.supported) throw new BadRequestException('Este provedor precisa de um gateway de IA configurado no servidor');
    return provider;
  }
  private async requireGlobalModelAdmin(tenantId: string, userId?: string) {
    if (!userId || !await this.prisma.userRole.findFirst({ where: { userId, user: { tenantId, status: 'ACTIVE' }, role: { name: 'SUPER_ADMIN' } } })) {
      throw new ForbiddenException('Somente SUPER_ADMIN pode alterar o catálogo global de modelos e preços');
    }
  }
  async createModel(tenantId: string, input: CreateModelDto, userId?: string) {
    await this.requireGlobalModelAdmin(tenantId, userId);
    const inputPrice = validateModelPrice(input.inputPrice, 'inputPrice');
    const outputPrice = validateModelPrice(input.outputPrice, 'outputPrice');
    if (!input.name?.trim() || !input.slug?.trim()) throw new BadRequestException('Informe nome e identificador do modelo');
    if (gatewayRoutingActive() && !isAllowedRoute(input.slug)) throw new BadRequestException(routePolicyMessage(input.slug.trim()));
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.requireSupportedProvider(tx, input.providerId);
        const model = await tx.aiModel.create({ data: { providerId: input.providerId, name: input.name.trim(), slug: input.slug.trim(), inputPrice, outputPrice, ...(input.capabilities !== undefined ? { capabilities: input.capabilities === null ? Prisma.DbNull : input.capabilities as Prisma.InputJsonObject } : {}) }, include: modelInclude });
        await tx.auditLog.create({ data: { tenantId, userId, event: 'model.created', resource: 'models', resourceId: model.id, metadata: { providerId: model.providerId, slug: model.slug } } });
        return serializeModel(model);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Este identificador já está cadastrado para o provedor');
      throw error;
    }
  }
  async updateModel(tenantId: string, id: string, input: UpdateModelDto, userId?: string) {
    await this.requireGlobalModelAdmin(tenantId, userId);
    const inputPrice = validateModelPrice(input.inputPrice, 'inputPrice');
    const outputPrice = validateModelPrice(input.outputPrice, 'outputPrice');
    if ((input.name !== undefined && !input.name?.trim()) || (input.slug !== undefined && !input.slug?.trim())) throw new BadRequestException('Informe nome e identificador do modelo');
    if (input.slug !== undefined && gatewayRoutingActive() && !isAllowedRoute(input.slug)) throw new BadRequestException(routePolicyMessage(input.slug.trim()));
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.aiModel.findUnique({ where: { id } });
        if (!existing) throw new NotFoundException('Modelo não encontrado');
        await this.requireSupportedProvider(tx, input.providerId ?? existing.providerId);
        const model = await tx.aiModel.update({ where: { id }, data: { providerId: input.providerId, name: input.name?.trim(), slug: input.slug?.trim(), inputPrice, outputPrice, ...(input.capabilities !== undefined ? { capabilities: input.capabilities === null ? Prisma.DbNull : input.capabilities as Prisma.InputJsonObject } : {}) }, include: modelInclude });
        await tx.auditLog.create({ data: { tenantId, userId, event: 'model.updated', resource: 'models', resourceId: model.id, metadata: { providerId: model.providerId, slug: model.slug } } });
        return serializeModel(model);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Este identificador já está cadastrado para o provedor');
      throw error;
    }
  }
  users(tenantId: string) { return this.prisma.user.findMany({ where: { tenantId }, select: userSelect, orderBy: { name: 'asc' } }); }
  roles() { return this.prisma.role.findMany({ include: { permissions: { include: { permission: true } } }, orderBy: { name: 'asc' } }); }

  private async validateUserRelations(tx: Prisma.TransactionClient, tenantId: string, input: UpdateUserDto, actorId: string) {
    if (input.departmentId && !await tx.department.findFirst({ where: { id: input.departmentId, tenantId } })) throw new BadRequestException('Departamento não pertence à prefeitura');
    if (input.roleIds !== undefined) {
      if (!Array.isArray(input.roleIds) || new Set(input.roleIds).size !== input.roleIds.length) throw new BadRequestException('Perfis inválidos');
      const roles = await tx.role.findMany({ where: { id: { in: input.roleIds } } });
      if (roles.length !== input.roleIds.length) throw new BadRequestException('Perfil não encontrado');
      if (roles.some((role) => role.name === 'SUPER_ADMIN')) {
        const superAdmin = await tx.userRole.findFirst({ where: { userId: actorId, user: { tenantId, status: 'ACTIVE' }, role: { name: 'SUPER_ADMIN' } } });
        if (!superAdmin) throw new ForbiddenException('Somente um SUPER_ADMIN pode atribuir este perfil');
      }
    }
  }

  async createUser(tenantId: string, input: CreateUserDto, actorId: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.validateUserRelations(tx, tenantId, input, actorId);
        if (input.status !== 'SUSPENDED') await assertLicenseCapacity(tx, tenantId, 'users');
        const user = await tx.user.create({ data: { tenantId, name: input.name.trim(), email: input.email.trim().toLowerCase(), departmentId: input.departmentId, status: input.status ?? 'ACTIVE', roles: { create: (input.roleIds ?? []).map((roleId) => ({ roleId })) } }, select: userSelect });
        await tx.auditLog.create({ data: { tenantId, userId: actorId, event: 'user.created', resource: 'users', resourceId: user.id, metadata: { status: user.status } } });
        if (input.roleIds?.length) await tx.auditLog.create({ data: { tenantId, userId: actorId, event: 'permission.changed', resource: 'users', resourceId: user.id, metadata: { roleIds: input.roleIds } } });
        return user;
      });
    } catch (error) { conflict(error); }
  }

  async updateUser(tenantId: string, id: string, input: UpdateUserDto, actorId: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.user.findFirst({ where: { id, tenantId }, include: { roles: { select: { roleId: true } } } });
        if (!existing) throw new NotFoundException('Usuário não encontrado');
        await this.validateUserRelations(tx, tenantId, input, actorId);
        if (existing.status === 'SUSPENDED' && input.status !== undefined && input.status !== 'SUSPENDED') await assertLicenseCapacity(tx, tenantId, 'users');
        const privilegedTarget = await tx.userRole.findFirst({ where: { userId: id, role: { name: 'SUPER_ADMIN' } } });
        if (privilegedTarget && !await tx.userRole.findFirst({ where: { userId: actorId, role: { name: 'SUPER_ADMIN' } } })) throw new ForbiddenException('Somente um SUPER_ADMIN pode editar este usuário');
        if (input.roleIds !== undefined) {
          await tx.userRole.deleteMany({ where: { userId: id } });
          if (input.roleIds.length) await tx.userRole.createMany({ data: input.roleIds.map((roleId) => ({ userId: id, roleId })) });
        }
        const user = await tx.user.update({ where: { id }, data: { name: input.name?.trim(), email: input.email?.trim().toLowerCase(), departmentId: input.departmentId, status: input.status }, select: userSelect });
        await tx.auditLog.create({ data: { tenantId, userId: actorId, event: 'user.updated', resource: 'users', resourceId: user.id, metadata: { status: user.status } } });
        if (input.roleIds !== undefined && (input.roleIds.length !== existing.roles.length || input.roleIds.some((roleId) => !existing.roles.some((binding) => binding.roleId === roleId)))) {
          await tx.auditLog.create({ data: { tenantId, userId: actorId, event: 'permission.changed', resource: 'users', resourceId: user.id, metadata: { roleIds: input.roleIds } } });
        }
        return user;
      });
    } catch (error) { conflict(error); }
  }

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
