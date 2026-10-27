import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission } from '../auth/permissions.decorator';
import { AiGatewayService } from './ai-gateway.service';
import { EXPORT_FORMATS, ExportFormat } from './chat-export';

class ConversationQueryDto {
  @IsOptional() @IsUUID() agentId?: string;
}

class ExportQueryDto {
  @IsIn(EXPORT_FORMATS, { message: 'Escolha o formato pdf, docx ou xlsx.' }) format!: ExportFormat;
}

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly gateway: AiGatewayService) {}

  @Get() @RequirePermission('conversations', 'read')
  list(@Req() request: AuthenticatedRequest, @Query() query: ConversationQueryDto) {
    return this.gateway.listConversations(request.user!.tenantId, request.user!.sub, query.agentId);
  }

  @Get(':id') @RequirePermission('conversations', 'read')
  get(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.gateway.getConversation(request.user!.tenantId, request.user!.sub, id);
  }

  /** Back to the full messages: the summary is discarded and no longer rebuilt for this conversation. */
  @Post(':id/summary/disable') @HttpCode(200) @RequirePermission('conversations', 'read')
  disableSummary(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.gateway.setSummaryDisabled(request.user!.tenantId, request.user!.sub, id, true);
  }

  @Post(':id/summary/enable') @HttpCode(200) @RequirePermission('conversations', 'read')
  enableSummary(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.gateway.setSummaryDisabled(request.user!.tenantId, request.user!.sub, id, false);
  }

  @Get(':id/messages/:messageId/export') @RequirePermission('conversations', 'read')
  export(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Param('messageId', ParseUUIDPipe) messageId: string, @Query() query: ExportQueryDto) {
    return this.gateway.exportMessage(request.user!.tenantId, request.user!.sub, id, messageId, query.format);
  }
}
