const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('reflect-metadata');
const { SgdmOrganizationService, departmentExternalIdFor } = require('../dist/sgdm/sgdm-organization.service');
const { settingsFromSgdm } = require('../dist/catalog/tenant-settings');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const envKeys = ['SGDM_API_URL', 'SGDM_INTEGRATION_KEY', 'SGDM_ORG_CACHE_SECONDS', 'SGDM_INTERNAL_HOSTS', 'NODE_ENV'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
test.afterEach(() => envKeys.forEach(key => savedEnv[key] === undefined ? delete process.env[key] : process.env[key] = savedEnv[key]));

const prefeitura = { nome: 'Prefeitura de Sinop', cidade: 'Sinop', estado: 'MT', fuso: 'America/Cuiaba' };
const setor = (id, nome, extra = {}) => ({ id, nome, sigla: null, ativo: true, ordem: 0, membros: [], ...extra });

async function sgdm(t, reply) {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ url: request.url, auth: request.headers.authorization });
    const [status, body] = reply(request);
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  process.env.NODE_ENV = 'test';
  process.env.SGDM_API_URL = `http://127.0.0.1:${server.address().port}/api/v1`;
  process.env.SGDM_INTEGRATION_KEY = 'integration-secret';
  return calls;
}

// In-memory stand-in for the Prisma calls of the organization sync, with the (tenantId, externalId) unique key.
function database({ departments = [] } = {}) {
  const db = { tenant: { id: TENANT, name: 'Antigo', settings: { theme: 'dark', retentionDays: 30 } }, departments: departments.map(item => ({ ...item })) };
  let id = 0;
  const matches = (item, where) => item.tenantId === where.tenantId
    && (!where.status || item.status !== where.status.not)
    && (!where.OR || where.OR.some(clause => clause.externalId === null ? item.externalId == null : !clause.externalId.notIn.includes(item.externalId)));
  const tx = {
    tenant: { update: async ({ where, data }) => { assert.equal(where.id, TENANT); return Object.assign(db.tenant, data); } },
    department: {
      upsert: async ({ where, create, update }) => {
        const key = where.tenantId_externalId;
        const found = db.departments.find(item => item.tenantId === key.tenantId && item.externalId === key.externalId);
        if (found) return Object.assign(found, update);
        const record = { id: 'dep-' + (++id), ...create };
        db.departments.push(record);
        return record;
      },
      updateMany: async ({ where, data }) => { const hits = db.departments.filter(item => matches(item, where)); hits.forEach(item => Object.assign(item, data)); return { count: hits.length }; },
    },
  };
  return { db, prisma: { ...tx, $transaction: async fn => fn(tx) } };
}

test('settingsFromSgdm maps the prefeitura with the documented fixed values', () => {
  assert.deepEqual(settingsFromSgdm(prefeitura), { organizationName: 'Prefeitura de Sinop', timezone: 'America/Cuiaba', locale: 'pt-BR', theme: 'system', allowSignups: false, retentionDays: null });
});

test('disabled integration returns null and touches nothing', async () => {
  delete process.env.SGDM_API_URL; delete process.env.SGDM_INTEGRATION_KEY;
  const { db, prisma } = database();
  assert.equal(await new SgdmOrganizationService(prisma).sync(TENANT), null);
  assert.equal(db.tenant.name, 'Antigo');
});

test('two setores with the same name in different functions become two departments', async t => {
  const calls = await sgdm(t, () => [200, { prefeitura, setores: [setor('s-1', 'Compras', { sigla: 'CPR' }), setor('s-2', 'Compras', { ordem: 1 })] }]);
  const { db, prisma } = database();
  const org = await new SgdmOrganizationService(prisma).sync(TENANT);
  assert.equal(calls[0].url, `/api/v1/integracoes/i7ai/organizacao/${TENANT}`);
  assert.equal(calls[0].auth, 'Bearer integration-secret');
  assert.equal(org.setores.length, 2);
  assert.deepEqual(db.departments.map(item => [item.externalId, item.name, item.status]), [['s-1', 'Compras', 'ACTIVE'], ['s-2', 'Compras', 'ACTIVE']]);
  assert.equal(db.tenant.name, 'Prefeitura de Sinop');
  assert.deepEqual(db.tenant.settings, settingsFromSgdm(prefeitura));
});

test('inactive setor, removed setor and legacy departments without externalId become INACTIVE', async t => {
  await sgdm(t, () => [200, { prefeitura, setores: [setor('s-1', 'Obras', { ativo: false }), setor('s-2', 'Saúde')] }]);
  const { db, prisma } = database({ departments: [
    { id: 'legacy', tenantId: TENANT, externalId: null, name: 'Compras', status: 'ACTIVE' },
    { id: 'removed', tenantId: TENANT, externalId: 's-old', name: 'Extinto', status: 'ACTIVE' },
    { id: 'other', tenantId: 'other-tenant', externalId: null, name: 'Outra', status: 'ACTIVE' },
    { id: 'renamed', tenantId: TENANT, externalId: 's-2', name: 'Saude antiga', status: 'INACTIVE' },
  ] });
  await new SgdmOrganizationService(prisma).sync(TENANT);
  const status = Object.fromEntries(db.departments.map(item => [item.id, item.status]));
  assert.deepEqual(status, { legacy: 'INACTIVE', removed: 'INACTIVE', other: 'ACTIVE', renamed: 'ACTIVE', 'dep-1': 'INACTIVE' });
  assert.equal(db.departments.find(item => item.id === 'renamed').name, 'Saúde');
});

test('cache: a second call within the TTL does not call SGDM; errors fall back to the cache or null', async t => {
  let reply = [200, { prefeitura, setores: [] }];
  const calls = await sgdm(t, () => reply);
  const { prisma } = database();
  const service = new SgdmOrganizationService(prisma);
  const first = await service.sync(TENANT);
  assert.deepEqual(await service.sync(TENANT), first);
  assert.equal(calls.length, 1);
  process.env.SGDM_ORG_CACHE_SECONDS = '0';
  const expiring = new SgdmOrganizationService(prisma);
  expiring.logger = { warn: () => {} };
  await expiring.sync(TENANT);
  reply = [500, { message: 'boom' }];
  assert.deepEqual(await expiring.sync(TENANT), first);
  assert.equal(calls.length, 3);
  const fresh = new SgdmOrganizationService(prisma);
  fresh.logger = { warn: () => {} };
  assert.equal(await fresh.sync(TENANT), null);
});

test('a malformed answer is rejected before any department is touched, and the key never reaches the log', async t => {
  await sgdm(t, () => [200, { prefeitura, setores: [{ id: 's-1' }] }]);
  const { db, prisma } = database({ departments: [{ id: 'keep', tenantId: TENANT, externalId: 's-1', name: 'Compras', status: 'ACTIVE' }] });
  const service = new SgdmOrganizationService(prisma);
  const warnings = [];
  service.logger = { warn: message => warnings.push(message) };
  assert.equal(await service.sync(TENANT), null);
  assert.equal(db.departments[0].status, 'ACTIVE');
  assert.equal(db.tenant.name, 'Antigo');
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('integration-secret'));
});

test('departmentExternalIdFor: CHEFE wins, then lowest ordem, then nome; inactive setores and strangers get null', () => {
  const membro = { usuarioId: USER, papel: 'MEMBRO' }, chefe = { usuarioId: USER, papel: 'CHEFE' };
  const org = setores => ({ prefeitura, setores });
  assert.equal(departmentExternalIdFor(org([setor('a', 'Alfa', { membros: [membro] }), setor('b', 'Beta', { ordem: 9, membros: [chefe] })]), USER), 'b');
  assert.equal(departmentExternalIdFor(org([setor('a', 'Alfa', { ordem: 5, membros: [membro] }), setor('b', 'Beta', { ordem: 2, membros: [membro] })]), USER), 'b');
  assert.equal(departmentExternalIdFor(org([setor('a', 'Órgão', { membros: [membro] }), setor('b', 'Obras', { membros: [membro] })]), USER), 'b');
  assert.equal(departmentExternalIdFor(org([setor('a', 'Alfa', { ativo: false, membros: [chefe] }), setor('b', 'Beta', { membros: [membro] })]), USER), 'b');
  assert.equal(departmentExternalIdFor(org([setor('a', 'Alfa', { ativo: false, membros: [chefe] })]), USER), null);
  assert.equal(departmentExternalIdFor(org([setor('a', 'Alfa', { membros: [{ usuarioId: 'outro', papel: 'CHEFE' }] })]), USER), null);
});

test('GET /settings: SGDM settings as stored, defaultModelId from the released default, standalone defaults kept', async () => {
  const { CatalogService } = require('../dist/catalog/catalog.service');
  let stored = settingsFromSgdm(prefeitura);
  const prisma = {
    tenant: { findUnique: async () => ({ id: TENANT, name: 'Prefeitura de Sinop', slug: 'sgdm', settings: stored }) },
    aiModel: { findFirst: async ({ where }) => (where.slug === 'openai/gpt-5.5' && where.active ? { id: 'model-1' } : null) },
  };
  const released = { allowed: async () => ({ slugs: ['openai/gpt-5.5'], defaultSlug: 'openai/gpt-5.5' }) };
  assert.deepEqual((await new CatalogService(prisma, released).settings(TENANT)).settings, { ...settingsFromSgdm(prefeitura), defaultModelId: 'model-1' });
  const down = { allowed: async () => { throw new Error('SGDM fora'); } };
  assert.equal((await new CatalogService(prisma, down).settings(TENANT)).settings.defaultModelId, null);
  stored = {};
  const standalone = { allowed: async () => null };
  assert.deepEqual((await new CatalogService(prisma, standalone).settings(TENANT)).settings, { timezone: 'America/Cuiaba', locale: 'pt-BR', theme: 'system' });
  stored = { defaultModelId: 'local-model', retentionDays: 30 };
  assert.deepEqual((await new CatalogService(prisma, standalone).settings(TENANT)).settings, { timezone: 'America/Cuiaba', locale: 'pt-BR', theme: 'system', defaultModelId: 'local-model', retentionDays: 30 });
});
