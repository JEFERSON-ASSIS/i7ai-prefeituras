import { Body, Controller, Header, HttpCode, Ip, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CentralConversationsService } from './central-conversations.service';
import { OpenConversationDto } from './dto/open-conversation.dto';

// No @RequirePermission: access is the SGDM IA_CENTRAL flag, checked first in the service.
@Controller('central/conversas')
@UseGuards(JwtAuthGuard)
export class CentralConversationsController {
  constructor(private readonly conversations: CentralConversationsService) {}

  @Post(':id/abrir') @HttpCode(200) @Header('Cache-Control', 'no-store')
  open(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: OpenConversationDto, @Ip() ip?: string) {
    return this.conversations.open(request.user, id, body.motivo, ip);
  }
}
