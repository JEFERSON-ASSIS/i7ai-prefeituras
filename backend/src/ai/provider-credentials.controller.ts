import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IsString, MaxLength } from 'class-validator';
import { RequirePermission } from '../auth/permissions.decorator';
import { ProviderCredentialsService } from './provider-credentials.service';

export class ProviderCredentialDto {
  @IsString() @MaxLength(512) apiKey!: string;
}

@Controller('ai-credentials')
@UseGuards(JwtAuthGuard)
export class ProviderCredentialsController {
  constructor(private readonly credentials: ProviderCredentialsService) {}
  @Get() @RequirePermission('models', 'write')
  list(@Req() req: AuthenticatedRequest) { return this.credentials.list(req.user!); }
  @Put(':provider') @RequirePermission('models', 'write')
  save(@Req() req: AuthenticatedRequest, @Param('provider') provider: string, @Body() body: ProviderCredentialDto) { return this.credentials.save(req.user!, provider, body?.apiKey); }
  @Delete(':provider') @RequirePermission('models', 'write')
  remove(@Req() req: AuthenticatedRequest, @Param('provider') provider: string) { return this.credentials.remove(req.user!, provider); }
  @Post(':provider/test') @RequirePermission('models', 'write')
  test(@Req() req: AuthenticatedRequest, @Param('provider') provider: string) { return this.credentials.test(req.user!, provider); }
}
