import { BadRequestException, Body, Controller, HttpCode, NotFoundException, Post, Req, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { SgdmNamesService } from './sgdm-names.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 200;

/** Compares sha256 digests so length and content never leak through timing. */
function sameKey(received: string, expected: string) {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

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
    const expected = process.env.SGDM_INTEGRATION_KEY?.trim();
    if (!expected) throw new NotFoundException();
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header) : null;
    if (!match || !sameKey(match[1].trim(), expected)) throw new UnauthorizedException('Chave de integração inválida.');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Corpo inválido.');
    const { agentes, conversas } = body as { agentes?: unknown; conversas?: unknown };
    return this.service.resolve(idList(agentes, 'agentes'), idList(conversas, 'conversas'));
  }
}
