import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission } from '../auth/permissions.decorator';
import { CatalogService } from './catalog.service';
import { LicenseDto } from './catalog.dto';

/** Users, departments and settings are read-only here: SGDM is their source (spec decisions 9 and 10). */
@Controller()
@UseGuards(JwtAuthGuard)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}
  @Get('settings') @RequirePermission('settings', 'read')
  settings(@Req() req: AuthenticatedRequest) { return this.catalog.settings(req.user!.tenantId); }
  @Get('departments') @RequirePermission('departments', 'read')
  departments(@Req() req: AuthenticatedRequest) { return this.catalog.departments(req.user!.tenantId); }
  @Get('models') @RequirePermission('models', 'read')
  models(@Req() req: AuthenticatedRequest) { return this.catalog.models(req.user!); }
  @Get('providers') @RequirePermission('models', 'read')
  providers() { return this.catalog.providers(); }
  @Get('roles') @RequirePermission('users', 'read')
  roles() { return this.catalog.roles(); }
  @Get('users') @RequirePermission('users', 'read')
  users(@Req() req: AuthenticatedRequest) { return this.catalog.users(req.user!.tenantId); }
  @Get('licensing') @RequirePermission('licensing', 'read')
  licensing(@Req() req: AuthenticatedRequest) { return this.catalog.licensing(req.user!.tenantId); }
  @Patch('licensing') @RequirePermission('licensing', 'write')
  updateLicense(@Req() req: AuthenticatedRequest, @Body() body: LicenseDto) { return this.catalog.updateLicense(req.user!.tenantId, body, req.user!.sub); }
}
