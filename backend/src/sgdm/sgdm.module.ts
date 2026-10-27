import { Module } from '@nestjs/common';
import { SgdmAccessService } from './sgdm-access.service';
import { SgdmOrganizationService } from './sgdm-organization.service';

/**
 * Single home of the SGDM server-to-server integration. It must not import AuthModule,
 * CatalogModule or AiGatewayModule (they import this one).
 */
@Module({ providers: [SgdmAccessService, SgdmOrganizationService], exports: [SgdmAccessService, SgdmOrganizationService] })
export class SgdmModule {}
