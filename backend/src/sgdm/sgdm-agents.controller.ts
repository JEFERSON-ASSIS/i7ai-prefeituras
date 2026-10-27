import { BadRequestException, Controller, Get, Query, Req } from '@nestjs/common';
import { assertIntegrationKey } from './integration-key';
import { SgdmAgentsService } from './sgdm-agents.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server-to-server only: the shared integration key is the sole credential. */
@Controller('integracoes/sgdm')
export class SgdmAgentsController {
  constructor(private readonly service: SgdmAgentsService) {}

  /** Active agents of one prefeitura, for the SGDM assistant rules. */
  @Get('agentes')
  async agents(@Req() request: { headers: Record<string, string | string[] | undefined> }, @Query() query: Record<string, unknown>) {
    assertIntegrationKey(request.headers.authorization);
    if (typeof query?.tenantId !== 'string' || !UUID.test(query.tenantId)) throw new BadRequestException('"tenantId" deve ser um identificador válido.');
    return this.service.list(query.tenantId);
  }
}
