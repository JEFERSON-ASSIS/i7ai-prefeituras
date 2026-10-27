import { BadRequestException, Controller, Get, Query, Req } from '@nestjs/common';
import { assertIntegrationKey } from './integration-key';
import { SgdmResearchService } from './sgdm-research.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const DAY = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD as UTC midnight; rejects impossible dates such as 2026-02-30. */
function day(value: unknown, field: string): Date {
  const date = typeof value === 'string' && DATE.test(value) ? new Date(value + 'T00:00:00.000Z') : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new BadRequestException(`"${field}" deve ser uma data no formato AAAA-MM-DD.`);
  return date;
}

/** Server-to-server only: the shared integration key is the sole credential. */
@Controller('integracoes/sgdm')
export class SgdmResearchController {
  constructor(private readonly service: SgdmResearchService) {}

  @Get('pesquisas')
  async research(@Req() request: { headers: Record<string, string | string[] | undefined> }, @Query() query: Record<string, unknown>) {
    assertIntegrationKey(request.headers.authorization);
    const from = day(query?.inicio, 'inicio'); const last = day(query?.fim, 'fim');
    if (last < from) throw new BadRequestException('"fim" deve ser igual ou posterior a "inicio".');
    if ((last.getTime() - from.getTime()) / DAY + 1 > MAX_DAYS) throw new BadRequestException(`O período máximo é de ${MAX_DAYS} dias.`);
    let tenantId: string | undefined;
    if (query.tenantId !== undefined && query.tenantId !== '') {
      if (typeof query.tenantId !== 'string' || !UUID.test(query.tenantId)) throw new BadRequestException('"tenantId" deve ser um identificador válido.');
      tenantId = query.tenantId;
    }
    return this.service.research({ inicio: query.inicio as string, fim: query.fim as string, from, to: new Date(last.getTime() + DAY), tenantId });
  }
}
