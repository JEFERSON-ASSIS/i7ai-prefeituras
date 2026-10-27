const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('reflect-metadata');
const { SgdmIdentityService } = require('../dist/auth/sgdm-identity.service');
const { SgdmOrganizationService } = require('../dist/sgdm/sgdm-organization.service');
const { JwtAuthGuard } = require('../dist/auth/jwt-auth.guard');
const roleCatalog = require('../dist/auth/role-catalog');
const scriptCatalog = require('../scripts/permissions.cjs');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const envKeys = ['SGDM_API_URL', 'SGDM_INTEGRATION_KEY', 'SGDM_ORG_CACHE_SECONDS', 'SGDM_INTERNAL_HOSTS', 'SGDM_SESSION_CACHE_SECONDS', 'NODE_ENV'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
test.afterEach(() => envKeys.forEach(key => savedEnv[key] === undefined ? delete process.env[key] : process.env[key] = savedEnv[key]));

const token = (exp = Math.floor(Date.now() / 1000) + 3600) => 'h.' + Buffer.from(JSON.stringify({ sub: USER, exp })).toString('base64url') + '.s';
const me = (permissoes, extra = {}) => ({ id: USER, nome: 'Maria Servidora', email: 'Maria@Prefeitura.gov.br', tenantId: TENANT, tenant: { id: TENANT, nome: 'Prefeitura de Teste' }, perfis: ['QUALQUER_NOME'], permissoes, ...extra });

async function sgdm(t, respond) {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ url: request.url, auth: request.headers.authorization, forwarded: request.headers['x-forwarded-for'] });
    const [status, body] = respond(calls.length, request.url);
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  process.env.NODE_ENV = 'test';
  process.env.SGDM_API_URL = `http://127.0.0.1:${server.address().port}/api/v1/`;
  return calls;
}

// In-memory stand-in for the Prisma calls used by the sync.
function database({ users = [], licenses = [], departments = [] } = {}) {
  const db = { tenants: [], users: users.map(item => ({ ...item })), departments: departments.map(item => ({ ...item })), roles: [], permissions: [], rolePermissions: [], userRoles: [], audits: [] };
  let id = 0;
  const next = () => 'id-' + (++id);
  const tx = {
    $queryRaw: async () => [],
    tenant: {
      upsert: async ({ where, create, update }) => { const found = db.tenants.find(item => item.id === where.id); if (found) return Object.assign(found, update); db.tenants.push({ ...create }); return create; },
      update: async ({ where, data }) => Object.assign(db.tenants.find(item => item.id === where.id), data),
    },
    department: {
      upsert: async ({ where, create, update }) => {
        const key = where.tenantId_externalId;
        const found = db.departments.find(item => item.tenantId === key.tenantId && item.externalId === key.externalId);
        if (found) return Object.assign(found, update);
        const record = { id: 'dep-' + create.externalId, ...create };
        db.departments.push(record);
        return record;
      },
      updateMany: async ({ where, data }) => {
        const hits = db.departments.filter(item => item.tenantId === where.tenantId && item.status !== where.status.not
          && where.OR.some(clause => clause.externalId === null ? item.externalId == null : !clause.externalId.notIn.includes(item.externalId)));
        hits.forEach(item => Object.assign(item, data));
        return { count: hits.length };
      },
      findUnique: async ({ where }) => db.departments.find(item => item.tenantId === where.tenantId_externalId.tenantId && item.externalId === where.tenantId_externalId.externalId) || null,
    },
    license: { findFirst: async () => licenses[0] || null },
    user: {
      findUnique: async ({ where }) => db.users.find(item => (where.id && item.id === where.id) || (where.email && item.email === where.email)) || null,
      create: async ({ data }) => { db.users.push({ ...data }); return data; },
      update: async ({ where, data }) => Object.assign(db.users.find(item => item.id === where.id), data),
      count: async ({ where }) => db.users.filter(item => item.tenantId === where.tenantId).length,
    },
    role: {
      findUnique: async ({ where }) => db.roles.find(item => item.name === where.name) || null,
      create: async ({ data }) => { const role = { id: next(), ...data }; db.roles.push(role); return role; },
    },
    permission: { upsert: async ({ where }) => { const key = where.resource_action; let found = db.permissions.find(item => item.resource === key.resource && item.action === key.action); if (!found) { found = { id: next(), ...key }; db.permissions.push(found); } return found; } },
    rolePermission: { create: async ({ data }) => { db.rolePermissions.push(data); return data; } },
    userRole: {
      findMany: async ({ where }) => db.userRoles.filter(link => link.userId === where.userId).map(link => ({ ...link, role: db.roles.find(role => role.id === link.roleId) })).filter(link => where.role.name.in.includes(link.role.name)),
      deleteMany: async ({ where }) => { db.userRoles = db.userRoles.filter(link => !(link.userId === where.userId && where.roleId.in.includes(link.roleId))); },
      create: async ({ data }) => { db.userRoles.push(data); return data; },
    },
    auditLog: { create: async ({ data }) => { db.audits.push(data); return data; } },
  };
  const prisma = { ...tx, $transaction: async fn => fn(tx) };
  const roleNames = userId => db.userRoles.filter(link => link.userId === userId).map(link => db.roles.find(role => role.id === link.roleId).name).sort();
  return { db, prisma, roleNames };
}

test('the TypeScript role catalog matches the provisioning script', () => {
  for (const role of [...scriptCatalog.ROLE_NAMES, 'SUPER_ADMIN']) assert.deepEqual(roleCatalog.permissionEntries(role), scriptCatalog.permissionEntries(role), role);
  assert.deepEqual([...roleCatalog.ROLE_NAMES], scriptCatalog.ROLE_NAMES);
});

test('SGDM permission codes map to i7Ai roles; perfil names are ignored', () => {
  assert.deepEqual(roleCatalog.rolesFromSgdm(['DOCUMENTO_CRIAR', 'I7AI_USAR']), ['USUARIO']);
  assert.deepEqual(roleCatalog.rolesFromSgdm(['I7AI_ADMINISTRAR', 'I7AI_CONSTRUIR', 'I7AI_USAR']), ['ADMIN', 'CONSTRUTOR', 'USUARIO']);
  assert.deepEqual(roleCatalog.rolesFromSgdm(['PLATAFORMA_ADMINISTRAR']), ['SUPER_ADMIN']);
  assert.deepEqual(roleCatalog.rolesFromSgdm(['ADMINISTRADOR', 'IA_CONFIGURAR']), []);
});

test('first access validates the session at SGDM and creates the prefeitura, user and roles', async t => {
  const calls = await sgdm(t, () => [200, me(['I7AI_USAR', 'I7AI_CONSTRUIR'])]);
  const { db, prisma, roleNames } = database();
  const session = token();
  const identity = await new SgdmIdentityService(prisma).resolve(session, '203.0.113.9');
  assert.equal(calls[0].url, '/api/v1/auth/me');
  assert.equal(calls[0].auth, 'Bearer ' + session);
  assert.equal(calls[0].forwarded, '203.0.113.9');
  assert.deepEqual(identity.roles, ['CONSTRUTOR', 'USUARIO']);
  assert.deepEqual(db.tenants[0], { id: TENANT, name: 'Prefeitura de Teste', slug: 'sgdm-' + TENANT, status: 'ACTIVE' });
  assert.equal(db.users[0].email, 'maria@prefeitura.gov.br');
  assert.equal(db.users[0].status, 'ACTIVE');
  assert.deepEqual(roleNames(USER), ['CONSTRUTOR', 'USUARIO']);
  assert.equal(db.audits[0].event, 'user.sgdm.created');
});

test('later sessions follow SGDM: roles removed and added, name updated; cache avoids repeated calls', async t => {
  let permissoes = ['I7AI_ADMINISTRAR'];
  const calls = await sgdm(t, () => [200, me(permissoes)]);
  const { db, prisma, roleNames } = database();
  const service = new SgdmIdentityService(prisma);
  await service.resolve(token());
  await service.resolve(token());
  assert.equal(calls.length, 1);
  permissoes = ['I7AI_USAR', 'PLATAFORMA_ADMINISTRAR'];
  process.env.SGDM_SESSION_CACHE_SECONDS = '0';
  const fresh = new SgdmIdentityService(prisma);
  await fresh.resolve(token(Math.floor(Date.now() / 1000) + 7200));
  assert.deepEqual(roleNames(USER), ['SUPER_ADMIN', 'USUARIO']);
  assert.equal(db.audits.at(-1).event, 'user.sgdm.roles_synced');
});

test('users without any i7Ai permission are refused before anything is stored', async t => {
  await sgdm(t, () => [200, me(['DOCUMENTO_CRIAR'])]);
  const { db, prisma } = database();
  await assert.rejects(new SgdmIdentityService(prisma).resolve(token()), /I7AI_USAR/);
  assert.equal(db.users.length, 0);
  assert.equal(db.tenants.length, 0);
});

test('SGDM rejections, outages and malformed identities never create users', async t => {
  let reply = [401, { message: 'revogado' }];
  await sgdm(t, () => reply);
  const { db, prisma } = database();
  const service = new SgdmIdentityService(prisma);
  await assert.rejects(service.resolve(token()), /Sessão do SGDM inválida/);
  reply = [500, {}];
  await assert.rejects(service.resolve(token()), /não validou/);
  reply = [200, me(['I7AI_USAR'], { id: 'nao-uuid' })];
  await assert.rejects(service.resolve(token()), /identidade inválida/);
  assert.equal(db.users.length, 0);
});

test('an e-mail already used by another i7Ai user is refused', async t => {
  await sgdm(t, () => [200, me(['I7AI_USAR'])]);
  const { prisma } = database({ users: [{ id: '33333333-3333-4333-8333-333333333333', tenantId: TENANT, email: 'maria@prefeitura.gov.br', name: 'Outra', status: 'ACTIVE' }] });
  await assert.rejects(new SgdmIdentityService(prisma).resolve(token()), /e-mail/);
});

test('a full license blocks new users from that prefeitura', async t => {
  process.env.NODE_ENV = 'test';
  await sgdm(t, () => [200, me(['I7AI_USAR'])]);
  const license = { status: 'ACTIVE', startDate: new Date(0), endDate: null, maxUsers: 1 };
  const { prisma } = database({ users: [{ id: '44444444-4444-4444-8444-444444444444', tenantId: TENANT, email: 'outro@prefeitura.gov.br', name: 'Outro', status: 'ACTIVE' }], licenses: [license] });
  await assert.rejects(new SgdmIdentityService(prisma).resolve(token()), /Limite de usuários/);
});

test('SGDM URL follows the HTTPS policy, with internal Docker hosts opt-in', async t => {
  await sgdm(t, () => [200, me(['I7AI_USAR'])]);
  const { prisma } = database();
  process.env.NODE_ENV = 'production';
  process.env.SGDM_API_URL = 'http://sgdm-api:3001/api/v1';
  await assert.rejects(new SgdmIdentityService(prisma).resolve(token()), /HTTPS/);
});

test('the guard uses SGDM when configured and the local mirror for roles and permissions', async t => {
  await sgdm(t, () => [200, me(['I7AI_USAR'])]);
  const { prisma } = database();
  let lookup;
  const guardPrisma = { user: { findFirst: async query => { lookup = query.where; return { id: USER, tenantId: TENANT, email: 'maria@prefeitura.gov.br', name: 'Maria', roles: [{ role: { name: 'USUARIO', permissions: [{ permission: { resource: 'conversations', action: 'write' } }] } }] }; } } };
  const jwt = { verifyAsync: async () => { throw new Error('local verification must not run'); }, decode: () => null };
  const guard = new JwtAuthGuard(jwt, guardPrisma, new SgdmIdentityService(prisma));
  const request = { headers: { authorization: 'Bearer ' + token() }, ip: '203.0.113.9' };
  assert.equal(await guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) }), true);
  assert.deepEqual(lookup, { id: USER, tenantId: TENANT, status: 'ACTIVE', tenant: { status: 'ACTIVE' } });
  assert.deepEqual(request.user.permissions, ['conversations:write']);
});

const prefeitura = { nome: 'Prefeitura de Sinop', cidade: 'Sinop', estado: 'MT', fuso: 'America/Cuiaba' };
const setor = (id, nome, extra = {}) => ({ id, nome, sigla: null, ativo: true, ordem: 0, membros: [{ usuarioId: USER, papel: 'MEMBRO' }], ...extra });

// Fake SGDM answering /auth/me and the organization contract of `GET /integracoes/i7ai/organizacao/:tenantId`.
async function sgdmWithOrganization(t, organization) {
  const calls = await sgdm(t, (_, url) => url.includes('/integracoes/i7ai/organizacao/') ? organization() : [200, me(['I7AI_USAR'])]);
  process.env.SGDM_INTEGRATION_KEY = 'integration-secret';
  process.env.SGDM_SESSION_CACHE_SECONDS = '0';
  process.env.SGDM_ORG_CACHE_SECONDS = '0';
  return calls;
}
const quiet = service => { service.logger = { warn: () => {} }; return service; };

test('login places the user in the department of their SGDM setor', async t => {
  const calls = await sgdmWithOrganization(t, () => [200, { prefeitura, setores: [setor('s-compras', 'Compras', { ordem: 2 }), setor('s-gabinete', 'Gabinete', { membros: [{ usuarioId: USER, papel: 'CHEFE' }], ordem: 5 })] }]);
  const { db, prisma } = database();
  await new SgdmIdentityService(prisma, new SgdmOrganizationService(prisma)).resolve(token());
  const organizationCall = calls.find(call => call.url.includes('/organizacao/'));
  assert.equal(organizationCall.url, `/api/v1/integracoes/i7ai/organizacao/${TENANT}`);
  assert.equal(organizationCall.auth, 'Bearer integration-secret');
  assert.equal(db.users[0].departmentId, 'dep-s-gabinete');
  assert.equal(db.tenants[0].name, 'Prefeitura de Sinop');
  assert.equal(db.tenants[0].settings.timezone, 'America/Cuiaba');
});

test('two setores with the same name and an inactivated setor with users never break the login', async t => {
  let setores = [setor('s-1', 'Compras'), setor('s-2', 'Compras', { ordem: 1, membros: [] })];
  await sgdmWithOrganization(t, () => [200, { prefeitura, setores }]);
  const { db, prisma } = database({ departments: [{ id: 'legacy', tenantId: TENANT, externalId: null, name: 'Compras', status: 'ACTIVE' }] });
  const service = new SgdmIdentityService(prisma, new SgdmOrganizationService(prisma));
  await service.resolve(token());
  assert.equal(db.users[0].departmentId, 'dep-s-1');
  assert.deepEqual(db.departments.map(item => [item.id, item.status]), [['legacy', 'INACTIVE'], ['dep-s-1', 'ACTIVE'], ['dep-s-2', 'ACTIVE']]);
  setores = [setor('s-1', 'Compras', { ativo: false }), setor('s-2', 'Compras', { ordem: 1, membros: [] })];
  await service.resolve(token(Math.floor(Date.now() / 1000) + 7200));
  assert.equal(db.users[0].departmentId, null);
  assert.equal(db.departments.find(item => item.id === 'dep-s-1').status, 'INACTIVE');
});

test('/organizacao answering 500 completes the login and keeps the department', async t => {
  await sgdmWithOrganization(t, () => [500, { message: 'boom' }]);
  const existing = { id: USER, tenantId: TENANT, email: 'maria@prefeitura.gov.br', name: 'Maria Servidora', status: 'ACTIVE', departmentId: 'dep-anterior' };
  const { db, prisma } = database({ users: [existing] });
  let departmentWrites = 0;
  const update = prisma.user.update;
  prisma.user.update = async query => { if ('departmentId' in query.data) departmentWrites++; return update(query); };
  const identity = await new SgdmIdentityService(prisma, quiet(new SgdmOrganizationService(prisma))).resolve(token());
  assert.equal(identity.id, USER);
  assert.equal(db.users[0].departmentId, 'dep-anterior');
  assert.equal(departmentWrites, 0);
});

test('the department is written only when it changes', async t => {
  await sgdmWithOrganization(t, () => [200, { prefeitura, setores: [setor('s-1', 'Compras')] }]);
  const existing = { id: USER, tenantId: TENANT, email: 'maria@prefeitura.gov.br', name: 'Maria Servidora', status: 'ACTIVE', departmentId: 'dep-s-1' };
  const { prisma } = database({ users: [existing], departments: [{ id: 'dep-s-1', tenantId: TENANT, externalId: 's-1', name: 'Compras', status: 'ACTIVE' }] });
  let departmentWrites = 0;
  const update = prisma.user.update;
  prisma.user.update = async query => { if ('departmentId' in query.data) departmentWrites++; return update(query); };
  await new SgdmIdentityService(prisma, new SgdmOrganizationService(prisma)).resolve(token());
  assert.equal(departmentWrites, 0);
});
