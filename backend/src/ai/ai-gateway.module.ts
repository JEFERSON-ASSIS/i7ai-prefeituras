import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AiGatewayController } from './ai-gateway.controller';
import { AiGatewayService } from './ai-gateway.service';
import { ConversationsController } from './conversations.controller';
import { ToolsModule } from '../tools/tools.module';
import { McpModule } from '../mcp/mcp.module';
import { AgentToolsService } from './agent-tools.service';
import { AiQuotaService } from './ai-quota.service';
import { OmniRouterService } from './omnirouter.service';
import { ChatAttachmentsController } from './chat-attachments.controller';
import { ChatCatalogController } from './chat-catalog.controller';
import { AgentsModule } from '../agents/agents.module';
import { CatalogModule } from '../catalog/catalog.module';
import { SgdmModule } from '../sgdm/sgdm.module';
import { TenantAiKeyService } from './tenant-ai-key.service';
import { ModelPricingSyncService } from './model-pricing-sync.service';

@Module({ imports: [AuthModule, KnowledgeModule, ToolsModule, McpModule, AgentsModule, CatalogModule, SgdmModule], controllers: [AiGatewayController, ConversationsController, ChatAttachmentsController, ChatCatalogController], providers: [AiGatewayService, AgentToolsService, AiQuotaService, OmniRouterService, TenantAiKeyService, ModelPricingSyncService], exports: [AiGatewayService] })
export class AiGatewayModule {}
