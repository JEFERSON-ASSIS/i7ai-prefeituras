import { BadRequestException, Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { assertIntegrationKey } from './integration-key';
import { SgdmNamesService } from './sgdm-names.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 200;

function idList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IDS || !value.every(item => typeof item === 'string' && UUID.test(item))) {
    throw new BadRequestException(`"${field}" deve ser uma lista de até ${MAX_IDS} identificadores válidos.`);
  }
  return [...new Set(value as string[])];
}

/** Server-to-server only: no JWT, no permission; the shared integration key is the sole credential. */
@Controller('integracoes/sgdm')
export class SgdmNamesController {
  constructor(private readonly service: SgdmNamesService) {}

  @Post('nomes')
  @HttpCode(200)
  async names(@Req() request: { headers: Record<string, string | string[] | undefined> }, @Body() body: unknown) {
    assertIntegrationKey(request.headers.authorization);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Corpo inválido.');
    const { agentes, conversas } = body as { agentes?: unknown; conversas?: unknown };
    return this.service.resolve(idList(agentes, 'agentes'), idList(conversas, 'conversas'));
  }
}
