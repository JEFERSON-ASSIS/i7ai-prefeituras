import { Module } from '@nestjs/common';
import { SgdmAccessService } from './sgdm-access.service';

/**
 * Single home of the SGDM server-to-server integration. It must not import AuthModule,
 * CatalogModule or AiGatewayModule (they import this one).
 */
@Module({ providers: [SgdmAccessService], exports: [SgdmAccessService] })
export class SgdmModule {}
