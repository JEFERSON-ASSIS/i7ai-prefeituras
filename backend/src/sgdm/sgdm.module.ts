import { Module } from '@nestjs/common';
import { SgdmAccessService } from './sgdm-access.service';
import { SgdmOrganizationService } from './sgdm-organization.service';
import { SgdmNamesController } from './sgdm-names.controller';
import { SgdmNamesService } from './sgdm-names.service';

/**
 * Single home of the SGDM server-to-server integration. It must not import AuthModule,
 * CatalogModule or AiGatewayModule (they import this one).
 */
@Module({ controllers: [SgdmNamesController], providers: [SgdmAccessService, SgdmOrganizationService, SgdmNamesService], exports: [SgdmAccessService, SgdmOrganizationService] })
export class SgdmModule {}
