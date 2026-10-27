import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission } from '../auth/permissions.decorator';
import { AgentsService } from '../agents/agents.service';
import { CatalogService } from '../catalog/catalog.service';
import { gatewayRoutingActive, isAllowedRoute } from '../catalog/model-route-policy';
import { SgdmAccessService } from '../sgdm/sgdm-access.service';

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatCatalogController {
  constructor(private readonly agents: AgentsService, private readonly catalog: CatalogService, private readonly access?: SgdmAccessService) {}

  @Get('catalog') @RequirePermission('agents', 'execute')
  async list(@Req() request: AuthenticatedRequest) {
    const { tenantId, sub } = request.user!;
    const [agents, active, allowed] = await Promise.all([this.agents.list(tenantId), this.catalog.activeModels(), this.access?.allowed(tenantId, sub) ?? null]);
    // Chat offers only what SGDM released to this user (no SUPER_ADMIN bypass: the server refuses the rest).
    let models = allowed ? active.filter(model => allowed.slugs.includes(model.slug)) : active;
    // Models on routes not cleared for municipal data stay visible to admins but are never offered in chat.
    if (gatewayRoutingActive()) models = models.filter(model => isAllowedRoute(model.slug));
    const defaultModelId = allowed?.defaultSlug ? models.find(model => model.slug === allowed.defaultSlug)?.id ?? null : null;
    return { agents: agents.filter(agent => agent.status === 'ACTIVE'), models, defaultModelId };
  }
}
