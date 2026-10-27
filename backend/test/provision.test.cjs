const test = require('node:test');
const assert = require('node:assert/strict');
const { readProvisionConfig, provision } = require('../scripts/provision.cjs');
const { ROLE_NAMES, permissionEntries } = require('../scripts/permissions.cjs');

function environment(extra = {}) {
  return { DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test', PROVISION_TENANT_NAME: 'Prefeitura de Teste', PROVISION_TENANT_SLUG: 'prefeitura-teste', PROVISION_ADMIN_EMAIL: 'ADMIN@example.test', PROVISION_ADMIN_NAME: 'Administrador', PROVISION_ADMIN_PASSWORD: 'Dummy-test-password-123', ...extra };
}
const caps = { PROVISION_CREATE_LICENSE: 'true', PROVISION_MAX_USERS: '5', PROVISION_MAX_AGENTS: '3', PROVISION_MAX_AUTOMATIONS: '2', PROVISION_MAX_KNOWLEDGE_BASES: '4', PROVISION_MAX_TOKENS: '50000', PROVISION_MAX_STORAGE_BYTES: '10485760' };

function database(initial = {}) {
  const state = { tenant: null, user: null, roles: [], bindings: [], license: null, provider: null, model: null, permissions: [], rolePermissions: [], audits: [], locks: [], ...initial };
  const prisma = {
    $queryRaw: async (query) => { state.locks.push(...(query.values || [])); return [{ acquired: 1 }]; },
    $transaction: async (operation) => {
      const snapshot = structuredClone(state);
      try { return await operation(prisma); }
      catch (error) { Object.assign(state, snapshot); throw error; }
    },
    tenant: { findUnique: async () => state.tenant, create: async ({ data }) => (state.tenant = { id: 'tenant-id', ...data }) },
    user: { findUnique: async () => state.user, create: async ({ data }) => (state.user = { id: 'user-id', ...data }), update: async () => { throw new Error('Existing user must never be modified'); } },
    role: { findUnique: async ({ where }) => state.roles.find((role) => role.name === where.name), create: async ({ data }) => { const role = { id: 'role-' + data.name, ...data }; state.roles.push(role); return role; }, update: async () => { throw new Error('Existing role must never be modified'); } },
    userRole: { create: async ({ data }) => { state.bindings.push(data); return data; }, findMany: async () => state.bindings, update: async () => { throw new Error('Existing role binding must never be modified'); } },
    permission: { upsert: async ({ create }) => { const permission = { id: create.resource + '-' + create.action, ...create }; state.permissions.push(permission); return permission; } },
    rolePermission: { upsert: async ({ create }) => { state.rolePermissions.push(create); return create; } },
    license: { findFirst: async () => state.license, create: async ({ data }) => (state.license = { id: 'license-id', ...data }), update: async () => { throw new Error('Existing license must never be modified'); } },
    aiProvider: { upsert: async ({ create }) => state.provider || (state.provider = { id: 'provider-id', ...create }) },
    aiModel: { findUnique: async () => state.model, create: async ({ data }) => (state.model = { id: 'model-id', ...data }), update: async () => { throw new Error('Existing model must never be modified'); } },
    auditLog: { create: async ({ data }) => { state.audits.push(data); return data; } },
  };
  return { prisma, state };
}

test('provisioning requires explicit identity without creating local credentials', () => {
  assert.equal(Object.hasOwn(readProvisionConfig(environment({ PROVISION_ADMIN_PASSWORD: '' })), 'adminPassword'), false);
  assert.throws(() => readProvisionConfig(environment({ PROVISION_TENANT_SLUG: '../tenant' })), /SLUG/);
  assert.throws(() => readProvisionConfig(environment({ PROVISION_ADMIN_EMAIL: 'invalid' })), /e-mail válido/);
});

test('platform privileges require exact explicit true; license caps have no defaults', () => {
  assert.equal(readProvisionConfig(environment()).platformAdmin, false);
  assert.equal(readProvisionConfig(environment({ PROVISION_PLATFORM_ADMIN: 'true' })).platformAdmin, true);
  assert.throws(() => readProvisionConfig(environment({ PROVISION_PLATFORM_ADMIN: 'yes' })), /true ou false/);
  assert.throws(() => readProvisionConfig(environment({ PROVISION_CREATE_LICENSE: 'true' })), /PROVISION_MAX_USERS/);
  const config = readProvisionConfig(environment(caps));
  assert.equal(config.license.maxTokens, 50000n);
  assert.equal(config.license.maxStorageBytes, 10485760n);
  assert.throws(() => readProvisionConfig(environment({ ...caps, PROVISION_MAX_STORAGE_BYTES: '9223372036854775808' })), /limite do banco/);
});

test('new admin gets ADMIN only, requested license caps and no invented model prices', async () => {
  const { prisma, state } = database();
  const config = readProvisionConfig(environment({ ...caps, PROVISION_MODEL_SLUG: 'requested-model' }));
  const result = await provision(prisma, config, { hashPassword: async () => 'hashed-for-test' });
  assert.deepEqual(result.adminRoleIds, ['role-ADMIN']);
  assert.equal(result.platformAdminGrantedThisRun, false);
  assert.equal(Object.hasOwn(state.user, 'passwordHash'), false);
  assert.equal(state.license.maxUsers, 5); assert.equal(state.license.maxAutomations, 2);
  assert.equal(state.model.slug, 'requested-model');
  assert.equal(state.model.inputPrice, null); assert.equal(state.model.outputPrice, null);
  const safe = JSON.stringify(result) + JSON.stringify(state.audits);
  assert.equal(safe.includes(config.adminEmail), false); assert.equal(safe.includes(config.databaseUrl), false);
});

test('rerunning provisioning preserves existing identity, password, roles and license', async () => {
  const { prisma, state } = database();
  let hashes = 0;
  const config = readProvisionConfig(environment(caps));
  await provision(prisma, config, { hashPassword: async () => { hashes++; return 'first-hash'; } });
  const original = { user: structuredClone(state.user), bindings: structuredClone(state.bindings), license: structuredClone(state.license), rolePermissions: structuredClone(state.rolePermissions) };
  const second = await provision(prisma, readProvisionConfig(environment({ ...caps, PROVISION_ADMIN_PASSWORD: 'Another-dummy-password-456', PROVISION_ADMIN_NAME: 'Novo Nome', PROVISION_PLATFORM_ADMIN: 'true', PROVISION_MAX_USERS: '99' })), { hashPassword: async () => { hashes++; return 'must-not-be-used'; } });
  assert.equal(hashes, 0);
  assert.deepEqual(state.user, original.user); assert.deepEqual(state.bindings, original.bindings);
  assert.deepEqual(state.license, original.license); assert.deepEqual(state.rolePermissions, original.rolePermissions);
  assert.equal(second.existingAdminPreserved, true); assert.equal(second.existingLicensePreserved, true);
  assert.equal(second.platformAdminGrantedThisRun, false); assert.equal(second.created.adminUser, false);
});

test('SUPER_ADMIN is assigned only when explicitly requested for a new identity', async () => {
  const { prisma, state } = database();
  const result = await provision(prisma, readProvisionConfig(environment({ PROVISION_PLATFORM_ADMIN: 'true' })), { hashPassword: async () => 'hashed' });
  assert.deepEqual(result.adminRoleIds, ['role-SUPER_ADMIN']);
  assert.equal(result.platformAdminGrantedThisRun, true);
  assert.equal(state.license, null);
});

test('existing role policy and model prices remain untouched', async () => {
  const existingModel = { id: 'existing-model', slug: 'requested-model', inputPrice: '0.123', outputPrice: '0.456' };
  const { prisma, state } = database({ roles: [{ id: 'custom-admin-role', name: 'ADMIN' }], rolePermissions: [{ roleId: 'custom-admin-role', permissionId: 'custom-permission' }], model: existingModel });
  await provision(prisma, readProvisionConfig(environment({ PROVISION_MODEL_SLUG: 'requested-model' })), { hashPassword: async () => 'hashed' });
  assert.deepEqual(state.rolePermissions.filter((binding) => binding.roleId === 'custom-admin-role'), [{ roleId: 'custom-admin-role', permissionId: 'custom-permission' }]);
  assert.deepEqual(state.model, existingModel);
  assert.equal(state.permissions.some((permission) => permission.resource === 'users' && permission.action === 'write'), false);
  assert.equal(state.permissions.some((permission) => permission.resource === 'licensing'), false);
});

test('empty production database receives limited profiles with locked creation and only ADMIN assigned', async () => {
  const { prisma, state } = database();
  const result = await provision(prisma, readProvisionConfig(environment()), { hashPassword: async () => 'hashed' });
  assert.deepEqual(state.roles.map((role) => role.name), ROLE_NAMES);
  assert.deepEqual(state.locks.filter((label) => typeof label === 'string' && label.startsWith('role:')), ROLE_NAMES.map((name) => 'role:' + name));
  assert.deepEqual(result.defaultRoleIds, Object.fromEntries(ROLE_NAMES.map((name) => [name, 'role-' + name])));
  assert.deepEqual(state.bindings, [{ userId: 'user-id', roleId: 'role-ADMIN' }]);
  assert.equal(state.roles.some((role) => role.name === 'SUPER_ADMIN'), false);
  for (const name of ROLE_NAMES) {
    const actual = state.rolePermissions.filter((binding) => binding.roleId === 'role-' + name).map((binding) => binding.permissionId).sort();
    const expected = permissionEntries(name).map((permission) => permission.resource + '-' + permission.action).sort();
    assert.deepEqual(actual, expected);
  }
  assert.equal(state.rolePermissions.some((binding) => binding.roleId === 'role-VISUALIZADOR' && binding.permissionId.endsWith('-write')), false);
  assert.equal(state.rolePermissions.some((binding) => binding.roleId === 'role-USUARIO' && binding.permissionId.startsWith('automations-')), false);
});

test('an existing admin cannot be moved from another tenant; transaction rolls back', async () => {
  const { prisma, state } = database({ user: { id: 'foreign-user', tenantId: 'another-tenant', email: 'admin@example.test', passwordHash: 'preserve' } });
  await assert.rejects(provision(prisma, readProvisionConfig(environment()), { hashPassword: async () => 'unused' }), /outra prefeitura/);
  assert.equal(state.tenant, null); assert.equal(state.user.tenantId, 'another-tenant');
  assert.equal(state.audits.length, 0);
});

test('shared permission mapping keeps limited profiles from editing users or licenses', () => {
  const builder = permissionEntries('CONSTRUTOR');
  assert.equal(builder.some((permission) => permission.resource === 'users' && permission.action === 'write'), false);
  assert.equal(builder.some((permission) => permission.resource === 'licensing'), false);
  for (const role of ['ADMIN', 'SUPER_ADMIN']) assert.equal(permissionEntries(role).some((permission) => permission.resource === 'licensing'), false, role);
  const user = permissionEntries('USUARIO');
  assert.equal(user.some((permission) => permission.resource === 'conversations' && permission.action === 'write'), true);
  assert.equal(user.some((permission) => permission.resource === 'automations'), false);
});
