import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission } from '../auth/permissions.decorator';
import { AgentsService } from '../agents/agents.service';
import { CatalogService } from '../catalog/catalog.service';
import { gatewayRoutingActive, isAllowedRoute } from '../catalog/model-route-policy';

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatCatalogController {
  constructor(private readonly agents: AgentsService, private readonly catalog: CatalogService) {}

  @Get('catalog') @RequirePermission('agents', 'execute')
  async list(@Req() request: AuthenticatedRequest) {
    const [agents, models] = await Promise.all([this.agents.list(request.user!.tenantId), this.catalog.models()]);
    // Models on routes not cleared for municipal data stay visible to admins but are never offered in chat.
    return { agents: agents.filter(agent => agent.status === 'ACTIVE'), models: gatewayRoutingActive() ? models.filter(model => isAllowedRoute(model.slug)) : models };
  }
}
