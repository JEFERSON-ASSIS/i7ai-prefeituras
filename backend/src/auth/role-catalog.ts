// Same rules as scripts/permissions.cjs (provisioning and seed); a test keeps both in sync.
export const ROLE_NAMES = ['ADMIN', 'CONSTRUTOR', 'GESTOR', 'USUARIO', 'VISUALIZADOR'] as const;
export const RESOURCES = ['dashboard', 'agents', 'models', 'departments', 'knowledge-bases', 'documents', 'tools', 'conversations', 'automations', 'schedules', 'executions', 'reports', 'users', 'settings', 'licensing'] as const;

export function permissionEntries(roleName: string): { resource: string; action: string }[] {
  if (![...ROLE_NAMES, 'SUPER_ADMIN'].includes(roleName as never)) throw new Error('Perfil de provisionamento inválido.');
  return RESOURCES.flatMap((resource) => {
    const actions = ['ADMIN', 'SUPER_ADMIN'].includes(roleName) ? ['read', 'write', 'execute']
      : roleName === 'CONSTRUTOR' ? (['users', 'settings', 'licensing'].includes(resource) ? ['read'] : ['read', 'write', 'execute'])
      : roleName === 'GESTOR' ? ['read', 'execute']
      : roleName === 'USUARIO' ? (['dashboard', 'agents', 'models', 'conversations'].includes(resource) ? ['read', 'execute', ...(resource === 'conversations' ? ['write'] : [])] : [])
      : ['read'];
    return actions.map((action) => ({ resource, action }));
  });
}

/**
 * SGDM permission codes that grant i7Ai roles. Codes are stable; SGDM perfil
 * names are per prefeitura and can be renamed, so they are never used here.
 */
export const SGDM_ROLE_MAP: Record<string, string> = {
  PLATAFORMA_ADMINISTRAR: 'SUPER_ADMIN',
  I7AI_ADMINISTRAR: 'ADMIN',
  I7AI_CONSTRUIR: 'CONSTRUTOR',
  I7AI_USAR: 'USUARIO',
};

/** Roles whose bindings mirror SGDM; any other role stays under i7Ai control. */
export const SGDM_MANAGED_ROLES = ['SUPER_ADMIN', ...ROLE_NAMES];

export function rolesFromSgdm(permissoes: string[]) {
  return [...new Set(permissoes.map(code => SGDM_ROLE_MAP[code]).filter(Boolean))].sort();
}
