import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission } from '../auth/permissions.decorator';
import { CatalogService } from './catalog.service';
import { CreateUserDto, DepartmentDto, LicenseDto, SettingsDto, UpdateDepartmentDto, UpdateUserDto } from './catalog.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}
  @Get('settings') @RequirePermission('settings', 'read')
  settings(@Req() req: AuthenticatedRequest) { return this.catalog.settings(req.user!.tenantId); }
  @Patch('settings') @RequirePermission('settings', 'write')
  updateSettings(@Req() req: AuthenticatedRequest, @Body() body: SettingsDto) { return this.catalog.updateSettings(req.user!.tenantId, body, req.user!.sub); }
  @Get('departments') @RequirePermission('departments', 'read')
  departments(@Req() req: AuthenticatedRequest) { return this.catalog.departments(req.user!.tenantId); }
  @Post('departments') @RequirePermission('departments', 'write')
  createDepartment(@Req() req: AuthenticatedRequest, @Body() body: DepartmentDto) { return this.catalog.createDepartment(req.user!.tenantId, body, req.user!.sub); }
  @Patch('departments/:id') @RequirePermission('departments', 'write')
  updateDepartment(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateDepartmentDto) { return this.catalog.updateDepartment(req.user!.tenantId, id, body, req.user!.sub); }
  @Get('models') @RequirePermission('models', 'read')
  models(@Req() req: AuthenticatedRequest) { return this.catalog.models(req.user!); }
  @Get('providers') @RequirePermission('models', 'read')
  providers() { return this.catalog.providers(); }
  @Get('roles') @RequirePermission('users', 'read')
  roles() { return this.catalog.roles(); }
  @Get('users') @RequirePermission('users', 'read')
  users(@Req() req: AuthenticatedRequest) { return this.catalog.users(req.user!.tenantId); }
  @Post('users') @RequirePermission('users', 'write')
  createUser(@Req() req: AuthenticatedRequest, @Body() body: CreateUserDto) { return this.catalog.createUser(req.user!.tenantId, body, req.user!.sub); }
  @Patch('users/:id') @RequirePermission('users', 'write')
  updateUser(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateUserDto) { return this.catalog.updateUser(req.user!.tenantId, id, body, req.user!.sub); }
  @Get('licensing') @RequirePermission('licensing', 'read')
  licensing(@Req() req: AuthenticatedRequest) { return this.catalog.licensing(req.user!.tenantId); }
  @Patch('licensing') @RequirePermission('licensing', 'write')
  updateLicense(@Req() req: AuthenticatedRequest, @Body() body: LicenseDto) { return this.catalog.updateLicense(req.user!.tenantId, body, req.user!.sub); }
}
