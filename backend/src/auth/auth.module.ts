import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { APP_GUARD } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { SgdmIdentityService } from './sgdm-identity.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [JwtAuthGuard, SgdmIdentityService, { provide: APP_GUARD, useClass: PermissionsGuard }],
  exports: [JwtAuthGuard, SgdmIdentityService, JwtModule],
})
export class AuthModule {}
