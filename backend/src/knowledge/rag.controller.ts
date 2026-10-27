import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RagService } from './rag.service';
import { RequirePermission } from '../auth/permissions.decorator';

@Controller('knowledge')
@UseGuards(JwtAuthGuard)
export class RagController {
  constructor(private readonly rag: RagService) {}

  @Get('search')
  @RequirePermission('documents', 'read')
  search(@Req() request: AuthenticatedRequest, @Query('q') query = '', @Query('limit') limit = '8') {
    return this.rag.search(request.user!.tenantId, query, Number(limit), undefined, request.user!.sub);
  }
}
