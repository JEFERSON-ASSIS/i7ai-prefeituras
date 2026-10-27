import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission } from '../auth/permissions.decorator';
import { CatalogService } from './catalog.service';

/**
 * Users, departments and settings are read-only here: SGDM is their source (spec decisions 9 and 10).
 * The license is registered in SGDM's Central de IA and copied by SgdmLicenseService (decision 17).
 */
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
}
