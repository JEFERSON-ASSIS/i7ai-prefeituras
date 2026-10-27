import { Module } from '@nestjs/common';
import { SgdmAccessService } from './sgdm-access.service';
import { SgdmOrganizationService } from './sgdm-organization.service';
import { SgdmLimitsService } from './sgdm-limits.service';
import { SgdmNamesController } from './sgdm-names.controller';
import { SgdmNamesService } from './sgdm-names.service';

/**
 * Single home of the SGDM server-to-server integration. It must not import AuthModule,
 * CatalogModule or AiGatewayModule (they import this one).
 */
@Module({ controllers: [SgdmNamesController], providers: [SgdmAccessService, SgdmOrganizationService, SgdmNamesService, SgdmLimitsService], exports: [SgdmAccessService, SgdmOrganizationService, SgdmLimitsService] })
export class SgdmModule {}
