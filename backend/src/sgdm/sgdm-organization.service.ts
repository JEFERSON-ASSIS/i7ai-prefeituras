import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizacaoI7ai, settingsFromSgdm } from '../catalog/tenant-settings';
import { CachedFetch, envSeconds, sgdmFailureSeconds } from './cached-fetch';
import { sgdmIntegrationEnabled, sgdmIntegrationGet } from './sgdm-integration';

export type { OrganizacaoI7ai } from '../catalog/tenant-settings';


/** SGDM_ORG_CACHE_SECONDS; empty, invalid or negative values fall back to 300. */
const cacheSeconds = () => envSeconds('SGDM_ORG_CACHE_SECONDS', 300);

const isString = (value: unknown): value is string => typeof value === 'string';
const nullableString = (value: unknown) => value === null || value === undefined || typeof value === 'string';

/** Validates SGDM's answer before anything is written: a malformed body must never inactivate departments. */
function parseOrganization(body: unknown): OrganizacaoI7ai {
  const value = body as Record<string, unknown> | null;
  const prefeitura = value?.prefeitura as Record<string, unknown> | undefined;
  if (!prefeitura || !isString(prefeitura.nome) || !prefeitura.nome.trim() || !isString(prefeitura.fuso)
    || !nullableString(prefeitura.cidade) || !nullableString(prefeitura.estado) || !Array.isArray(value?.setores)) {
    throw new Error('resposta inválida do SGDM');
  }
  const setores = (value!.setores as unknown[]).map(item => {
    const setor = item as Record<string, unknown> | null;
    if (!setor || !isString(setor.id) || !setor.id || !isString(setor.nome) || typeof setor.ativo !== 'boolean'
      || typeof setor.ordem !== 'number' || !nullableString(setor.sigla) || !Array.isArray(setor.membros)) {
      throw new Error('resposta inválida do SGDM');
    }
    const membros = (setor.membros as unknown[]).map(entry => {
      const membro = entry as Record<string, unknown> | null;
      if (!membro || !isString(membro.usuarioId) || (membro.papel !== 'MEMBRO' && membro.papel !== 'CHEFE')) throw new Error('resposta inválida do SGDM');
      return { usuarioId: membro.usuarioId, papel: membro.papel as 'MEMBRO' | 'CHEFE' };
    });
    return { id: setor.id, nome: setor.nome.trim() || setor.id, sigla: (setor.sigla as string | null | undefined) ?? null, ativo: setor.ativo, ordem: setor.ordem, membros };
  });
  return {
    prefeitura: { nome: prefeitura.nome.trim(), cidade: (prefeitura.cidade as string | null | undefined) ?? null, estado: (prefeitura.estado as string | null | undefined) ?? null, fuso: prefeitura.fuso },
    setores,
  };
}

/**
 * The single department of a user: among the active setores the user belongs to, the one where the
 * user is CHEFE, then the lowest `ordem`, then the name (pt-BR collation). null when there is none.
 */
export function departmentExternalIdFor(org: OrganizacaoI7ai, userId: string): string | null {
  const candidates = org.setores
    .filter(setor => setor.ativo)
    .map(setor => ({ setor, chefe: setor.membros.some(membro => membro.usuarioId === userId && membro.papel === 'CHEFE'), membro: setor.membros.some(membro => membro.usuarioId === userId) }))
    .filter(candidate => candidate.membro);
  candidates.sort((a, b) => Number(b.chefe) - Number(a.chefe) || a.setor.ordem - b.setor.ordem || a.setor.nome.localeCompare(b.setor.nome, 'pt-BR'));
  return candidates[0]?.setor.id ?? null;
}

/**
 * Mirrors the prefeitura registered in SGDM: its name and settings on the tenant, and its setores as
 * departments keyed by (tenantId, externalId). SGDM allows the same setor name in different functions,
 * so names are never unique here. Errors never block a login: the last answer (or null) is returned.
 */
@Injectable()
export class SgdmOrganizationService {
  private readonly logger = new Logger(SgdmOrganizationService.name);
  // Stale values never expire here: the last answer is used for as long as SGDM stays down.
  private readonly cache = new CachedFetch<OrganizacaoI7ai>({ ttlSeconds: cacheSeconds, staleSeconds: Infinity, failureSeconds: sgdmFailureSeconds });

  constructor(private readonly prisma: PrismaService) {}

  /** null when the SGDM integration is off: standalone mode keeps local departments and settings. */
  async sync(tenantId: string): Promise<OrganizacaoI7ai | null> {
    if (!sgdmIntegrationEnabled()) return null;
    try {
      // Concurrent logins of one prefeitura share a single refresh instead of racing on the same rows.
      return await this.cache.get(tenantId, () => this.refresh(tenantId), (error, servedStale) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn('Não foi possível sincronizar a organização da prefeitura ' + tenantId + ' com o SGDM (' + reason + ')' + (servedStale ? '; usando a última resposta.' : '.'));
      });
    } catch {
      return null; // never blocks a login; the failure is remembered for a short window
    }
  }

  private async refresh(tenantId: string): Promise<OrganizacaoI7ai> {
    const org = parseOrganization(await sgdmIntegrationGet<unknown>('/integracoes/i7ai/organizacao/' + encodeURIComponent(tenantId)));
    await this.store(tenantId, org);
    return org;
  }

  private async store(tenantId: string, org: OrganizacaoI7ai) {
    const externalIds = org.setores.map(setor => setor.id);
    await this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id: tenantId }, data: { name: org.prefeitura.nome.slice(0, 180), settings: settingsFromSgdm(org.prefeitura) as unknown as Prisma.InputJsonObject } });
      for (const setor of org.setores) {
        const status = setor.ativo ? 'ACTIVE' : 'INACTIVE';
        await tx.department.upsert({
          where: { tenantId_externalId: { tenantId, externalId: setor.id } },
          create: { tenantId, externalId: setor.id, name: setor.nome, status },
          update: { name: setor.nome, status },
        });
      }
      // Legacy local departments and setores no longer served by SGDM stay for history, inactive.
      await tx.department.updateMany({
        where: { tenantId, status: { not: 'INACTIVE' }, OR: [{ externalId: null }, { externalId: { notIn: externalIds } }] },
        data: { status: 'INACTIVE' },
      });
    }, { timeout: 15000 });
  }
}
