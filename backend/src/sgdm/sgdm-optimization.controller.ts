import { BadRequestException, Body, Controller, Get, Param, Patch, Query, Req } from '@nestjs/common';
import { assertIntegrationKey } from './integration-key';
import { SgdmSavingsService } from './sgdm-savings.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 92;
const DAY = 24 * 60 * 60 * 1000;
type IntegrationRequest = { headers: Record<string, string | string[] | undefined> };

/** YYYY-MM-DD as UTC midnight; rejects impossible dates such as 2026-02-30. */
function day(value: unknown, field: string): Date {
  const date = typeof value === 'string' && DATE.test(value) ? new Date(value + 'T00:00:00.000Z') : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new BadRequestException(`"${field}" deve ser uma data no formato AAAA-MM-DD.`);
  return date;
}
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new BadRequestException(`"${field}" deve ser um identificador válido.`);
  return value;
}
function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Corpo inválido.');
  return value as Record<string, unknown>;
}

/** Server-to-server only, called by SGDM's Central de IA: the shared integration key is the sole credential. */
@Controller('integracoes/sgdm')
export class SgdmOptimizationController {
  constructor(private readonly service: SgdmSavingsService) {}

  /** Savings per optimization, numbers only (ids, counts, tokens and US$). The period is inclusive, in UTC. */
  @Get('otimizacao/economia')
  async savings(@Req() request: IntegrationRequest, @Query() query: Record<string, unknown>) {
    assertIntegrationKey(request.headers.authorization);
    const from = day(query?.inicio, 'inicio'); const last = day(query?.fim, 'fim');
    if (last < from) throw new BadRequestException('"fim" deve ser igual ou posterior a "inicio".');
    if ((last.getTime() - from.getTime()) / DAY + 1 > MAX_DAYS) throw new BadRequestException(`O período máximo é de ${MAX_DAYS} dias.`);
    const tenantId = query.tenantId === undefined || query.tenantId === '' ? undefined : uuid(query.tenantId, 'tenantId');
    let saidaCurta = 500;
    if (query.saidaCurta !== undefined && query.saidaCurta !== '') {
      saidaCurta = Number(query.saidaCurta);
      if (typeof query.saidaCurta !== 'string' || !/^\d+$/.test(query.saidaCurta) || !Number.isSafeInteger(saidaCurta) || saidaCurta < 1 || saidaCurta > 1_000_000) {
        throw new BadRequestException('"saidaCurta" deve ser um número inteiro positivo.');
      }
    }
    return this.service.economia({ inicio: query.inicio as string, fim: query.fim as string, from, to: new Date(last.getTime() + DAY), tenantId, saidaCurta });
  }

  @Patch('agentes/:agentId/modelo')
  async swap(@Req() request: IntegrationRequest, @Param('agentId') agentId: string, @Body() raw: unknown) {
    assertIntegrationKey(request.headers.authorization);
    const input = body(raw);
    if (typeof input.slug !== 'string' || !input.slug.trim() || input.slug.length > 200) throw new BadRequestException('"slug" deve ser o identificador de um modelo.');
    return this.service.swapModel(uuid(input.tenantId, 'tenantId'), uuid(agentId, 'agentId'), input.slug.trim());
  }

  @Patch('agentes/:agentId/modelo/desfazer')
  async undo(@Req() request: IntegrationRequest, @Param('agentId') agentId: string, @Body() raw: unknown) {
    assertIntegrationKey(request.headers.authorization);
    return this.service.undoSwap(uuid(body(raw).tenantId, 'tenantId'), uuid(agentId, 'agentId'));
  }
}
