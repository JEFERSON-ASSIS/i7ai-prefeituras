import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAgentDto, UpdateAgentDto } from './dto/create-agent.dto';
import { assertLicenseCapacity } from '../catalog/license-policy';
import { publicModelCapabilities } from '../catalog/model-capabilities';

const agentInclude = {
  department: true,
  models: { include: { model: { include: { provider: { select: { id: true, name: true, slug: true } } } } } },
  tools: { include: { tool: { select: { id: true, name: true, description: true, type: true, status: true } } } },
  knowledgeBases: { include: { knowledgeBase: { include: { _count: { select: { documents: true } } } } } },
  _count: { select: { conversations: true, automations: true } },
} satisfies Prisma.AgentInclude;
type AgentRecord = Prisma.AgentGetPayload<{ include: typeof agentInclude }>;
function serialize(agent: AgentRecord) {
  return { ...agent, temperature: Number(agent.temperature),
    models: agent.models.map(binding => ({ ...binding, model: { ...binding.model, capabilities: publicModelCapabilities(binding.model.capabilities) } })),
    modelId: agent.models.find((binding) => binding.isPrimary)?.modelId ?? agent.models[0]?.modelId ?? null,
    knowledgeBaseIds: agent.knowledgeBases.map((binding) => binding.knowledgeBaseId),
    toolIds: agent.tools.filter((binding) => binding.enabled).map((binding) => binding.toolId),
  };
}

@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string) {
    const agents = await this.prisma.agent.findMany({ where: { tenantId }, include: agentInclude, orderBy: { updatedAt: 'desc' } });
    return agents.map(serialize);
  }

  async get(tenantId: string, id: string) {
    const agent = await this.prisma.agent.findFirst({ where: { id, tenantId }, include: agentInclude });
    if (!agent) throw new NotFoundException('Agente não encontrado');
    return serialize(agent);
  }

  private validateAdvancedReasoning(enabled: boolean | undefined) {
    if (enabled === true && (process.env.OMNIROUTER_BASE_URL || process.env.OMNIROUTER_API_KEY)) {
      throw new BadRequestException('O controle de raciocínio avançado não está disponível no OmniRoute. Desative essa opção para salvar o agente.');
    }
  }

  private async validateRelations(tx: Prisma.TransactionClient, tenantId: string, input: UpdateAgentDto) {
    if (input.departmentId && !await tx.department.findFirst({ where: { id: input.departmentId, tenantId } })) throw new BadRequestException('Departamento não pertence à prefeitura');
    if (input.modelId) {
      const model = await tx.aiModel.findUnique({ where: { id: input.modelId }, select: { id: true, active: true } });
      if (!model) throw new BadRequestException('Modelo não encontrado');
      if (model.active === false) throw new BadRequestException('Este modelo não está ativo na plataforma.');
    }
    if (input.knowledgeBaseIds !== undefined) {
      const ids = input.knowledgeBaseIds;
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length || await tx.knowledgeBase.count({ where: { id: { in: ids }, tenantId } }) !== ids.length) throw new BadRequestException('Uma ou mais bases não pertencem à prefeitura');
    }
    if (input.toolIds !== undefined) {
      const ids = input.toolIds;
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length || await tx.tool.count({ where: { id: { in: ids }, tenantId } }) !== ids.length) throw new BadRequestException('Uma ou mais ferramentas não pertencem à prefeitura');
    }
  }

  async create(tenantId: string, input: CreateAgentDto, createdById?: string) {
    this.validateAdvancedReasoning(input.advancedReasoning);
    return this.prisma.$transaction(async (tx) => {
      await this.validateRelations(tx, tenantId, input);
      if (createdById && !await tx.user.findFirst({ where: { id: createdById, tenantId } })) throw new BadRequestException('Usuário inválido');
      if (input.status !== 'ARCHIVED') await assertLicenseCapacity(tx, tenantId, 'agents');
      const agent = await tx.agent.create({ data: {
        tenantId, createdById, name: input.name.trim(), description: input.description,
        systemPrompt: input.systemPrompt, departmentId: input.departmentId,
        status: input.status ?? 'DRAFT', temperature: input.temperature ?? 0.2,
        maxTokens: input.maxTokens ?? 4000, advancedReasoning: input.advancedReasoning ?? false,
        models: input.modelId ? { create: [{ modelId: input.modelId, isPrimary: true }] } : undefined,
        knowledgeBases: { create: (input.knowledgeBaseIds ?? []).map((knowledgeBaseId) => ({ knowledgeBaseId })) },
        tools: { create: (input.toolIds ?? []).map((toolId) => ({ toolId })) },
      }, include: agentInclude });
      await tx.auditLog.create({ data: { tenantId, userId: createdById, event: 'agent.created', resource: 'agents', resourceId: agent.id, metadata: { status: agent.status } } });
      return serialize(agent);
    });
  }

  async update(tenantId: string, id: string, input: UpdateAgentDto, actorId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.agent.findFirst({ where: { id, tenantId } });
      if (!existing) throw new NotFoundException('Agente não encontrado');
      this.validateAdvancedReasoning(input.advancedReasoning ?? existing.advancedReasoning);
      await this.validateRelations(tx, tenantId, input);
      if (existing.status === 'ARCHIVED' && input.status !== undefined && input.status !== 'ARCHIVED') await assertLicenseCapacity(tx, tenantId, 'agents');
      if (input.modelId !== undefined) {
        await tx.agentModel.deleteMany({ where: { agentId: id } });
        if (input.modelId) await tx.agentModel.create({ data: { agentId: id, modelId: input.modelId, isPrimary: true } });
      }
      if (input.knowledgeBaseIds !== undefined) {
        await tx.agentKnowledgeBase.deleteMany({ where: { agentId: id } });
        if (input.knowledgeBaseIds.length) await tx.agentKnowledgeBase.createMany({ data: input.knowledgeBaseIds.map((knowledgeBaseId) => ({ agentId: id, knowledgeBaseId })) });
      }
      if (input.toolIds !== undefined) {
        await tx.agentTool.deleteMany({ where: { agentId: id } });
        if (input.toolIds.length) await tx.agentTool.createMany({ data: input.toolIds.map((toolId) => ({ agentId: id, toolId })) });
      }
      const agent = await tx.agent.update({ where: { id }, data: {
        name: input.name?.trim(), description: input.description, systemPrompt: input.systemPrompt,
        departmentId: input.departmentId, status: input.status, temperature: input.temperature,
        maxTokens: input.maxTokens, advancedReasoning: input.advancedReasoning,
      }, include: agentInclude });
      await tx.auditLog.create({ data: { tenantId, userId: actorId, event: 'agent.updated', resource: 'agents', resourceId: agent.id, metadata: { status: agent.status } } });
      return serialize(agent);
    });
  }
}
