import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

/** Compares sha256 digests so length and content never leak through timing. */
function sameKey(received: string, expected: string) {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

/**
 * Guards the server-to-server `/api/integracoes/sgdm/*` routes: without SGDM_INTEGRATION_KEY they do not
 * exist (404); a missing, malformed or wrong bearer is 401.
 */
export function assertIntegrationKey(authorization?: string | string[]): void {
  const expected = process.env.SGDM_INTEGRATION_KEY?.trim();
  if (!expected) throw new NotFoundException();
  const match = typeof authorization === 'string' ? /^Bearer (.+)$/.exec(authorization) : null;
  if (!match || !sameKey(match[1].trim(), expected)) throw new UnauthorizedException('Chave de integração inválida.');
}
