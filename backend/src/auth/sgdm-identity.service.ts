import { ForbiddenException, Injectable, Logger, Optional, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { gatewayBaseAllowed } from '../catalog/model-route-policy';
import { assertLicenseCapacity } from '../catalog/license-policy';
import { SGDM_MANAGED_ROLES, permissionEntries, rolesFromSgdm } from './role-catalog';
import { SgdmOrganizationService, departmentExternalIdFor } from '../sgdm/sgdm-organization.service';
import { SgdmLicenseService } from '../sgdm/sgdm-license.service';

export type SgdmIdentity = { id: string; tenantId: string; email: string; name: string; tenantName: string; roles: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CACHE = 5000;

/**
 * SGDM is the source of identity and permissions. Each new session is checked
 * against SGDM `GET /auth/me` (which applies SGDM's own revocation, deactivation
 * and fresh perfis), then the prefeitura, user and derived i7Ai roles are mirrored
 * locally so the rest of the API keeps using its database relations.
 */
@Injectable()
export class SgdmIdentityService {
  private readonly logger = new Logger(SgdmIdentityService.name);
  private readonly cache = new Map<string, { expires: number; identity: SgdmIdentity }>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly organization?: SgdmOrganizationService,
    @Optional() private readonly licenses?: SgdmLicenseService,
  ) {}

  enabled(env: NodeJS.ProcessEnv = process.env) {
    return Boolean(env.SGDM_API_URL?.trim());
  }

  async resolve(token: string, clientIp?: string): Promise<SgdmIdentity> {
    const key = createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.identity;
    this.cache.delete(key);

    const identity = this.parse(await this.fetchMe(token, clientIp));
    if (!identity.roles.length) throw new ForbiddenException('Seu perfil no SGDM não tem acesso ao i7Ai. Peça ao administrador uma permissão I7AI_USAR, I7AI_CONSTRUIR ou I7AI_ADMINISTRAR.');
    try {
      await this.sync(identity);
    } catch (error) {
      // Two first requests of the same user can race on the unique keys; the retry sees the winner's rows.
      if ((error as { code?: string })?.code !== 'P2002') throw error;
      await this.sync(identity);
    }

    const ttl = Math.max(0, Number(process.env.SGDM_SESSION_CACHE_SECONDS ?? 60)) * 1000;
    const expires = Math.min(now + ttl, this.tokenExpiry(token) ?? Infinity);
    if (ttl > 0 && expires > now) {
      if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(key, { expires, identity });
    }
    return identity;
  }

  private endpoint() {
    const configured = process.env.SGDM_API_URL!.trim();
    let base: URL;
    try { base = new URL(configured); } catch { throw new ServiceUnavailableException('SGDM_API_URL deve ser uma URL válida.'); }
    if (!gatewayBaseAllowed(base, process.env, 'SGDM_INTERNAL_HOSTS')) {
      throw new ServiceUnavailableException('SGDM_API_URL deve usar HTTPS, sem credenciais ou parâmetros. HTTP é permitido só para localhost no desenvolvimento ou serviços em SGDM_INTERNAL_HOSTS.');
    }
    return base.href.replace(/\/+$/, '') + '/auth/me';
  }

  private async fetchMe(token: string, clientIp?: string): Promise<unknown> {
    const endpoint = this.endpoint();
    let response: Response;
    try {
      response = await fetch(endpoint, {
        redirect: 'error', signal: AbortSignal.timeout(8000),
        // SGDM trusts one proxy hop: forwarding the user's IP keeps its per-IP limit per user.
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', ...(clientIp ? { 'X-Forwarded-For': clientIp } : {}) },
      });
    } catch {
      throw new ServiceUnavailableException('O SGDM não respondeu à validação da sessão.');
    }
    if (response.status === 401 || response.status === 403) throw new UnauthorizedException('Sessão do SGDM inválida ou expirada.');
    if (response.status === 429) throw new ServiceUnavailableException('O SGDM limitou as validações de sessão. Tente novamente em instantes.');
    if (!response.ok) throw new ServiceUnavailableException('O SGDM não validou a sessão (HTTP ' + response.status + ').');
    return response.json().catch(() => null);
  }

  private parse(value: unknown): SgdmIdentity {
    const me = value as Record<string, unknown> | null;
    const tenant = me?.tenant as Record<string, unknown> | undefined;
    const permissoes = Array.isArray(me?.permissoes) ? (me!.permissoes as unknown[]).filter((item): item is string => typeof item === 'string') : null;
    if (!me || typeof me.id !== 'string' || !UUID.test(me.id) || typeof me.tenantId !== 'string' || !UUID.test(me.tenantId)
      || typeof me.email !== 'string' || !me.email.includes('@') || !permissoes) {
      throw new UnauthorizedException('O SGDM retornou uma identidade inválida.');
    }
    const name = (typeof me.nome === 'string' && me.nome.trim()) || me.email;
    const tenantName = (typeof tenant?.nome === 'string' && tenant.nome.trim()) || 'Prefeitura';
    return { id: me.id, tenantId: me.tenantId, email: me.email.trim().toLowerCase(), name: name.slice(0, 160), tenantName: tenantName.slice(0, 180), roles: rolesFromSgdm(permissoes) };
  }

  private tokenExpiry(token: string) {
    try {
      const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp;
      return typeof exp === 'number' ? exp * 1000 : undefined;
    } catch { return undefined; }
  }

  private async sync(identity: SgdmIdentity) {
    // Read outside the transaction: a slow SGDM must not hold a database transaction open.
    // undefined (integration off or SGDM down) keeps the current license; the login never fails on it.
    const license = this.licenses ? await this.licenses.fetch(identity.tenantId) : undefined;
    await this.prisma.$transaction(async (tx) => {
      // i7Ai may suspend a prefeitura or user locally (license); SGDM never reactivates them.
      await tx.tenant.upsert({
        where: { id: identity.tenantId },
        create: { id: identity.tenantId, name: identity.tenantName, slug: 'sgdm-' + identity.tenantId, status: 'ACTIVE' },
        update: { name: identity.tenantName },
      });
      // Same transaction (no self-lock): a new user below is already counted against the SGDM license.
      if (license !== undefined) await this.licenses!.apply(tx, identity.tenantId, license);
      const emailOwner = await tx.user.findUnique({ where: { email: identity.email }, select: { id: true } });
      if (emailOwner && emailOwner.id !== identity.id) throw new UnauthorizedException('O e-mail deste usuário do SGDM já pertence a outro cadastro no i7Ai. Ajuste o cadastro antigo.');
      const existing = await tx.user.findUnique({ where: { id: identity.id }, select: { tenantId: true, status: true, name: true, email: true } });
      if (existing && existing.tenantId !== identity.tenantId) throw new UnauthorizedException('Este usuário pertence a outra prefeitura no i7Ai.');
      if (!existing) {
        // Without a license the user still enters and sees the license notice; with one, the user limit applies.
        if (await tx.license.findFirst({ where: { tenantId: identity.tenantId }, select: { id: true } })) await assertLicenseCapacity(tx, identity.tenantId, 'users');
        await tx.user.create({ data: { id: identity.id, tenantId: identity.tenantId, name: identity.name, email: identity.email, status: 'ACTIVE' } });
      } else if (existing.name !== identity.name || existing.email !== identity.email || existing.status === 'INVITED') {
        await tx.user.update({ where: { id: identity.id }, data: { name: identity.name, email: identity.email, ...(existing.status === 'INVITED' ? { status: 'ACTIVE' } : {}) } });
      }

      const current = await tx.userRole.findMany({ where: { userId: identity.id, role: { name: { in: SGDM_MANAGED_ROLES } } }, include: { role: true } });
      const currentNames = current.map(link => link.role.name);
      const stale = current.filter(link => !identity.roles.includes(link.role.name)).map(link => link.roleId);
      if (stale.length) await tx.userRole.deleteMany({ where: { userId: identity.id, roleId: { in: stale } } });
      for (const roleName of identity.roles.filter(name => !currentNames.includes(name))) {
        let role = await tx.role.findUnique({ where: { name: roleName } });
        if (!role) {
          role = await tx.role.create({ data: { name: roleName, description: roleName } });
          for (const { resource, action } of permissionEntries(roleName)) {
            const permission = await tx.permission.upsert({ where: { resource_action: { resource, action } }, update: {}, create: { resource, action } });
            await tx.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
          }
        }
        await tx.userRole.create({ data: { userId: identity.id, roleId: role.id } });
      }
      if (!existing || stale.length || identity.roles.some(name => !currentNames.includes(name))) {
        await tx.auditLog.create({ data: { tenantId: identity.tenantId, userId: identity.id, event: existing ? 'user.sgdm.roles_synced' : 'user.sgdm.created', resource: 'users', resourceId: identity.id, metadata: { roles: identity.roles } } });
      }
    });
    // After the commit: the organization sync updates the tenant row in its own transaction,
    // which would wait on the row lock held by the identity transaction above.
    await this.syncDepartment(identity);
  }

  /** Places the user in the department of their SGDM setor. Never blocks the login. */
  private async syncDepartment(identity: SgdmIdentity) {
    if (!this.organization) return;
    try {
      const org = await this.organization.sync(identity.tenantId);
      if (!org) return;
      const externalId = departmentExternalIdFor(org, identity.id);
      const department = externalId
        ? await this.prisma.department.findUnique({ where: { tenantId_externalId: { tenantId: identity.tenantId, externalId } }, select: { id: true } })
        : null;
      const departmentId = department?.id ?? null;
      const user = await this.prisma.user.findUnique({ where: { id: identity.id }, select: { departmentId: true } });
      if (user && user.departmentId !== departmentId) await this.prisma.user.update({ where: { id: identity.id }, data: { departmentId } });
    } catch (error) {
      this.logger.warn('Não foi possível atualizar o departamento do usuário ' + identity.id + ' (' + (error instanceof Error ? error.message : String(error)) + ').');
    }
  }
}
