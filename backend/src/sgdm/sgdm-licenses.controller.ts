import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { assertIntegrationKey } from './integration-key';
import { SgdmLicenseService } from './sgdm-license.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 200;
type IntegrationRequest = { headers: Record<string, string | string[] | undefined> };

/** Server-to-server only, called by SGDM's Central de IA: the shared integration key is the sole credential. */
@Controller('integracoes/sgdm')
export class SgdmLicensesController {
  constructor(private readonly service: SgdmLicenseService) {}

  @Get('licencas')
  async licenses(@Req() request: IntegrationRequest) {
    assertIntegrationKey(request.headers.authorization);
    return { licencas: await this.service.legacy() };
  }

  @Post('licencas/uso')
  @HttpCode(200)
  async usage(@Req() request: IntegrationRequest, @Body() body: unknown) {
    assertIntegrationKey(request.headers.authorization);
    const tenantIds = (body as { tenantIds?: unknown } | null)?.tenantIds;
    if (!Array.isArray(tenantIds) || tenantIds.length < 1 || tenantIds.length > MAX_IDS || !tenantIds.every(item => typeof item === 'string' && UUID.test(item))) {
      throw new BadRequestException(`"tenantIds" deve ser uma lista de 1 a ${MAX_IDS} identificadores válidos.`);
    }
    return { uso: await this.service.usage([...new Set(tenantIds as string[])]) };
  }
}
