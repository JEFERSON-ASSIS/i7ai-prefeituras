import { Module } from '@nestjs/common';
import { SgdmAccessService } from './sgdm-access.service';
import { SgdmOrganizationService } from './sgdm-organization.service';
import { SgdmLimitsService } from './sgdm-limits.service';
import { SgdmNamesController } from './sgdm-names.controller';
import { SgdmNamesService } from './sgdm-names.service';
import { SgdmLicenseService } from './sgdm-license.service';
import { SgdmLicensesController } from './sgdm-licenses.controller';
import { SgdmOptimizationService } from './sgdm-optimization.service';

/**
 * Single home of the SGDM server-to-server integration. It must not import AuthModule,
 * CatalogModule or AiGatewayModule (they import this one).
 */
@Module({
  controllers: [SgdmNamesController, SgdmLicensesController],
  providers: [SgdmAccessService, SgdmOrganizationService, SgdmNamesService, SgdmLimitsService, SgdmLicenseService, SgdmOptimizationService],
  exports: [SgdmAccessService, SgdmOrganizationService, SgdmLimitsService, SgdmLicenseService, SgdmOptimizationService],
})
export class SgdmModule {}
