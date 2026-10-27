import { CanActivate, ExecutionContext, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { validClaims } from './auth-policy';
import { tokenVerificationOptions } from './jwt-policy';
import { SgdmIdentityService } from './sgdm-identity.service';
const authenticated = Symbol('i7ai-authenticated');

export type AuthenticatedRequest = {
  headers: Record<string, string | undefined>;
  ip?: string;
  user?: { sub: string; tenantId: string; email: string; name: string; roles: string[]; permissions: string[]; centralIa: boolean };
  [authenticated]?: boolean;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly prisma: PrismaService, @Optional() private readonly sgdm?: SgdmIdentityService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request[authenticated]) return true;
    const header = request.headers['authorization'];
    const token = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice(7)
      : undefined;
    if (!token) throw new UnauthorizedException('Bearer token is required');

    let claims: unknown;
    let centralIa = false;
    if (this.sgdm?.enabled()) {
      // SGDM validates the session (signature, expiry, logout, deactivation) and
      // provides fresh permissions; the local mirror is refreshed from it.
      const identity = await this.sgdm.resolve(token, request.ip);
      claims = { sub: identity.id, tenantId: identity.tenantId };
      centralIa = identity.centralIa;
    } else {
      try {
        // The decoded issuer only selects a policy; signature verification remains mandatory.
        claims = await this.jwt.verifyAsync(token, tokenVerificationOptions(this.jwt.decode(token)));
      } catch {
        throw new UnauthorizedException('Invalid or expired token');
      }
    }
    if (!validClaims(claims)) throw new UnauthorizedException('Token sem identificação válida de usuário e prefeitura.');
    const user = await this.prisma.user.findFirst({
      where: { id: claims.sub, tenantId: claims.tenantId, status: 'ACTIVE', tenant: { status: 'ACTIVE' } },
      include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
    });
    if (!user) throw new UnauthorizedException('Usuário não cadastrado ou acesso suspenso nesta prefeitura.');
    const roles = user.roles.map(link => link.role.name);
    const permissions = user.roles.flatMap(link => link.role.permissions.map(item => item.permission.resource + ':' + item.permission.action));
    if (roles.includes('ADMIN') || roles.includes('SUPER_ADMIN')) permissions.push('*');
    request.user = { sub: user.id, tenantId: user.tenantId, email: user.email, name: user.name, roles, permissions: [...new Set(permissions)], centralIa };
    request[authenticated] = true;
    return true;
  }
}
