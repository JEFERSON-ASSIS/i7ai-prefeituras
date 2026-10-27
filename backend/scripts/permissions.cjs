const ROLE_NAMES = ['ADMIN', 'CONSTRUTOR', 'GESTOR', 'USUARIO', 'VISUALIZADOR'];
const RESOURCES = ['dashboard', 'agents', 'models', 'departments', 'knowledge-bases', 'documents', 'tools', 'conversations', 'automations', 'schedules', 'executions', 'reports', 'users', 'settings'];

function permissionEntries(roleName) {
  if (![...ROLE_NAMES, 'SUPER_ADMIN'].includes(roleName)) throw new Error('Perfil de provisionamento inválido.');
  return RESOURCES.flatMap((resource) => {
    const actions = ['ADMIN', 'SUPER_ADMIN'].includes(roleName) ? ['read', 'write', 'execute']
      : roleName === 'CONSTRUTOR' ? (['users', 'settings'].includes(resource) ? ['read'] : ['read', 'write', 'execute'])
      : roleName === 'GESTOR' ? ['read', 'execute']
      : roleName === 'USUARIO' ? (['dashboard', 'agents', 'models', 'conversations'].includes(resource) ? ['read', 'execute', ...(resource === 'conversations' ? ['write'] : [])] : [])
      : ['read'];
    return actions.map((action) => ({ resource, action }));
  });
}

async function ensureRolePermissions(prisma, roleId, roleName) {
  for (const { resource, action } of permissionEntries(roleName)) {
    const permission = await prisma.permission.upsert({ where: { resource_action: { resource, action } }, update: {}, create: { resource, action } });
    await prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId, permissionId: permission.id } }, update: {}, create: { roleId, permissionId: permission.id } });
  }
}

module.exports = { ROLE_NAMES, RESOURCES, permissionEntries, ensureRolePermissions };
