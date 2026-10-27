import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AgentsModule } from './agents/agents.module';
import { McpModule } from './mcp/mcp.module';
import { AuthModule } from './auth/auth.module';
import { ToolsModule } from './tools/tools.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { AiGatewayModule } from './ai/ai-gateway.module';
import { AutomationsModule } from './automations/automations.module';
import { CatalogModule } from './catalog/catalog.module';
import { InsightsModule } from './insights/insights.module';
import { SgdmModule } from './sgdm/sgdm.module';
import { RetentionService } from './retention/retention.service';

@Module({
  imports: [PrismaModule, AuthModule, AgentsModule, McpModule, ToolsModule, KnowledgeModule, AiGatewayModule, AutomationsModule, CatalogModule, InsightsModule, SgdmModule],
  controllers: [HealthController],
  providers: [RetentionService],
})
export class AppModule {}
