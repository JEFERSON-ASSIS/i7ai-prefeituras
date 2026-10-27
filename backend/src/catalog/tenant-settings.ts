/** Prefeitura data as served by SGDM's `GET /integracoes/i7ai/organizacao/:tenantId`. */
export interface OrganizacaoI7ai {
  prefeitura: { nome: string; cidade: string | null; estado: string | null; fuso: string };
  setores: {
    id: string; nome: string; sigla: string | null; ativo: boolean; ordem: number;
    membros: { usuarioId: string; papel: 'MEMBRO' | 'CHEFE' }[];
  }[];
}

export type TenantSettings = {
  organizationName: string; timezone: string; locale: string; theme: 'light' | 'dark' | 'system';
  allowSignups: boolean; retentionDays: number | null;
};

export const DEFAULT_TIMEZONE = 'America/Cuiaba';

function validTimezone(value: string) {
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: value }); return true; } catch { return false; }
}

/**
 * Tenant settings mirrored from the prefeitura registered in SGDM (spec decision 10).
 * Fields SGDM has no equivalent for get fixed values: users only come from SGDM (no sign-ups),
 * the theme follows SGDM's, and nothing is deleted automatically (retentionDays null).
 * defaultModelId is not stored: it is computed from SGDM's released default model on read.
 */
export function settingsFromSgdm(p: OrganizacaoI7ai['prefeitura']): TenantSettings {
  return {
    organizationName: p.nome,
    timezone: p.fuso && validTimezone(p.fuso) ? p.fuso : DEFAULT_TIMEZONE,
    locale: 'pt-BR',
    theme: 'system',
    allowSignups: false,
    retentionDays: null,
  };
}
