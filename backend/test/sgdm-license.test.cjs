const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('reflect-metadata');
const { NotFoundException, UnauthorizedException, BadRequestException } = require('@nestjs/common');
const { SgdmLicenseService } = require('../dist/sgdm/sgdm-license.service');
const { SgdmLicensesController } = require('../dist/sgdm/sgdm-licenses.controller');

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const envKeys = ['SGDM_API_URL', 'SGDM_INTEGRATION_KEY', 'SGDM_INTERNAL_HOSTS', 'NODE_ENV'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
test.afterEach(() => envKeys.forEach(key => savedEnv[key] === undefined ? delete process.env[key] : process.env[key] = savedEnv[key]));

// Fake SGDM implementing `GET /integracoes/i7ai/licenca/:tenantId` → `{ licenca: LicencaI7ai | null }`.
async function sgdm(t, respond) {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ url: request.url, auth: request.headers.authorization });
    const [status, body] = respond(request.url);
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

const licenca = (extra = {}) => ({ status: 'ACTIVE', startDate: '2026-01-01T03:00:00.000Z', endDate: '2027-01-01T03:00:00.000Z', maxUsers: 5, maxAgents: 6, maxAutomations: 7, maxKnowledgeBases: 8, maxStorageBytes: '10737418240', maxTokens: '5000000', ...extra });

// In-memory Prisma: tenants, licenses and the usage tables, all filtered by tenantId.
function database({ licenses = [], tenants = [{ id: T1, status: 'ACTIVE' }], rows = {} } = {}) {
  const db = { licenses: licenses.map(item => ({ ...item })), tenants, locks: [], users: [], agents: [], automations: [], knowledgeBases: [], documents: [], usages: [], reservations: [], ...rows };
  let id = 0;
  const byTenant = (list, where) => list.filter(item => item.tenantId === where.tenantId
    && (!where.status || (where.status.not ? item.status !== where.status.not : where.status.in.includes(item.status)))
    && (!where.createdAt || item.createdAt >= where.createdAt.gte));
  const newest = list => [...list].sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  const tx = {
    $queryRaw: async query => { db.locks.push(query.values[0]); return []; },
    tenant: { findMany: async ({ where }) => db.tenants.filter(item => item.status === where.status) },
    license: {
      findFirst: async ({ where }) => newest(db.licenses.filter(item => item.tenantId === where.tenantId)),
      findMany: async () => {
        const seen = new Set();
        return [...db.licenses].sort((a, b) => b.createdAt - a.createdAt).filter(item => !seen.has(item.tenantId) && seen.add(item.tenantId));
      },
      create: async ({ data }) => { const row = { id: 'lic-' + (++id), features: null, createdAt: new Date(Date.now() + id), ...data }; db.licenses.push(row); return row; },
      update: async ({ where, data }) => Object.assign(db.licenses.find(item => item.id === where.id), data),
    },
    user: { count: async ({ where }) => byTenant(db.users, where).length },
    agent: { count: async ({ where }) => byTenant(db.agents, where).length },
    automation: { count: async ({ where }) => byTenant(db.automations, where).length },
    knowledgeBase: { count: async ({ where }) => byTenant(db.knowledgeBases, where).length },
    document: { aggregate: async ({ where }) => ({ _sum: { sizeBytes: byTenant(db.documents, where).reduce((sum, item) => sum + item.sizeBytes, 0n) } }) },
    aiUsage: { aggregate: async ({ where }) => { const hits = byTenant(db.usages, where); return { _sum: { inputTokens: hits.reduce((s, i) => s + i.inputTokens, 0), outputTokens: hits.reduce((s, i) => s + i.outputTokens, 0) } }; } },
    aiTokenReservation: { aggregate: async ({ where }) => ({ _sum: { reservedTokens: byTenant(db.reservations, where).reduce((s, i) => s + i.reservedTokens, 0n) } }) },
  };
  const prisma = { ...tx, $transaction: async fn => fn(tx) };
  return { db, prisma, tx };
}
const service = prisma => { const instance = new SgdmLicenseService(prisma); const warnings = []; instance.logger = { warn: message => warnings.push(message), log: () => {} }; return { instance, warnings }; };

test('an ACTIVE snapshot creates the license with bigint storage; a second one updates the same row and keeps features', async t => {
  let current = licenca();
  const calls = await sgdm(t, () => [200, { licenca: current }]);
  const { db, prisma } = database();
  const { instance } = service(prisma);
  assert.deepEqual(await instance.syncAll(), { synced: 1 });
  assert.equal(calls[0].url, `/api/v1/integracoes/i7ai/licenca/${T1}`);
  assert.equal(calls[0].auth, 'Bearer integration-secret');
  assert.deepEqual(db.locks, [T1]);
  assert.equal(db.licenses.length, 1);
  const row = db.licenses[0];
  assert.equal(row.tenantId, T1);
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.maxUsers, 5);
  assert.equal(row.maxStorageBytes, 10737418240n);
  assert.equal(row.maxTokens, 5000000n);
  assert.equal(row.startDate.toISOString(), '2026-01-01T03:00:00.000Z');
  assert.equal(row.endDate.toISOString(), '2027-01-01T03:00:00.000Z');
  row.features = { ocr: true };
  current = licenca({ maxUsers: 8, endDate: null });
  await instance.syncAll();
  assert.equal(db.licenses.length, 1);
  assert.equal(db.licenses[0].maxUsers, 8);
  assert.equal(db.licenses[0].endDate, null);
  assert.deepEqual(db.licenses[0].features, { ocr: true });
});

test('with two local rows only the newest one changes', async t => {
  await sgdm(t, () => [200, { licenca: licenca({ maxUsers: 9, status: 'SUSPENDED' }) }]);
  const old = { id: 'old', tenantId: T1, status: 'ACTIVE', maxUsers: 1, createdAt: new Date('2025-01-01') };
  const recent = { id: 'recent', tenantId: T1, status: 'ACTIVE', maxUsers: 2, createdAt: new Date('2026-01-01') };
  const { db, prisma } = database({ licenses: [old, recent] });
  const { instance } = service(prisma);
  const snapshot = await instance.fetch(T1);
  assert.equal(snapshot.maxStorageBytes, 10737418240n);
  await prisma.$transaction(tx => instance.apply(tx, T1, snapshot));
  assert.deepEqual(db.licenses.map(item => [item.id, item.maxUsers, item.status]), [['old', 1, 'ACTIVE'], ['recent', 9, 'SUSPENDED']]);
});

test('{ licenca: null } keeps the local row and warns once per prefeitura', async t => {
  await sgdm(t, () => [200, { licenca: null }]);
  const local = { id: 'local', tenantId: T1, status: 'ACTIVE', maxUsers: 3, createdAt: new Date('2026-01-01') };
  const { db, prisma } = database({ licenses: [local] });
  const { instance, warnings } = service(prisma);
  assert.equal(await instance.fetch(T1), null);
  await instance.syncAll();
  await instance.syncAll();
  assert.deepEqual(db.licenses, [local]);
  assert.deepEqual(warnings, ['Licença local sem cadastro no SGDM; importe na Central de IA.']);
});

test('SGDM 500, 404 or a malformed answer: fetch returns undefined and nothing changes', async t => {
  let reply = [500, { message: 'boom' }];
  await sgdm(t, () => reply);
  const local = { id: 'local', tenantId: T1, status: 'ACTIVE', maxUsers: 3, createdAt: new Date('2026-01-01') };
  const { db, prisma } = database({ licenses: [local] });
  const { instance, warnings } = service(prisma);
  assert.equal(await instance.fetch(T1), undefined);
  assert.deepEqual(await instance.syncAll(), { synced: 0 });
  reply = [404, {}];
  assert.equal(await instance.fetch(T1), undefined);
  reply = [200, { licenca: licenca({ maxStorageBytes: 'muito' }) }];
  assert.equal(await instance.fetch(T1), undefined);
  reply = [200, { licenca: licenca({ startDate: 'ontem' }) }];
  assert.equal(await instance.fetch(T1), undefined);
  reply = [200, {}];
  assert.equal(await instance.fetch(T1), undefined);
  assert.deepEqual(db.licenses, [local]);
  assert.ok(warnings.length >= 2);
  assert.ok(warnings.every(message => !message.includes('integration-secret')));
});

test('integration disabled: fetch is undefined without calling or warning', async () => {
  delete process.env.SGDM_API_URL;
  delete process.env.SGDM_INTEGRATION_KEY;
  const { prisma } = database();
  const { instance, warnings } = service(prisma);
  assert.equal(await instance.fetch(T1), undefined);
  assert.deepEqual(await instance.syncAll(), { synced: 0 });
  assert.deepEqual(warnings, []);
});

test('usage of two prefeituras is counted separately, with big numbers as strings', async () => {
  const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const now = new Date();
  const { prisma } = database({ rows: {
    users: [{ tenantId: T1, status: 'ACTIVE' }, { tenantId: T1, status: 'SUSPENDED' }, { tenantId: T2, status: 'ACTIVE' }, { tenantId: T2, status: 'INVITED' }],
    agents: [{ tenantId: T1, status: 'ACTIVE' }, { tenantId: T1, status: 'ARCHIVED' }],
    automations: [{ tenantId: T2, status: 'ACTIVE' }],
    knowledgeBases: [{ tenantId: T1 }, { tenantId: T1 }],
    documents: [{ tenantId: T1, sizeBytes: 9007199254740993n }, { tenantId: T2, sizeBytes: 10n }],
    usages: [{ tenantId: T1, createdAt: now, inputTokens: 100, outputTokens: 50 }, { tenantId: T1, createdAt: new Date(month.getTime() - 1), inputTokens: 999, outputTokens: 0 }, { tenantId: T2, createdAt: now, inputTokens: 1, outputTokens: 2 }],
    reservations: [{ tenantId: T1, createdAt: now, status: 'RESERVED', reservedTokens: 40n }, { tenantId: T1, createdAt: now, status: 'SETTLED', reservedTokens: 1000n }, { tenantId: T2, createdAt: now, status: 'UNCERTAIN', reservedTokens: 7n }],
  } });
  const { instance } = service(prisma);
  assert.deepEqual(await instance.usage([T1, T2]), {
    [T1]: { users: 1, agents: 1, automations: 0, knowledgeBases: 2, storageBytes: '9007199254740993', tokensThisMonth: '150', reservedTokens: '40' },
    [T2]: { users: 2, agents: 0, automations: 1, knowledgeBases: 0, storageBytes: '10', tokensThisMonth: '3', reservedTokens: '7' },
  });
});

test('legacy returns only the newest row of each prefeitura, with big numbers as strings', async () => {
  const base = { status: 'ACTIVE', startDate: new Date('2026-01-01T03:00:00.000Z'), endDate: null, maxUsers: 1, maxAgents: 2, maxAutomations: 3, maxKnowledgeBases: 4, maxStorageBytes: 100n, maxTokens: 200n, features: { x: true } };
  const { prisma } = database({ licenses: [
    { ...base, id: 'a-old', tenantId: T1, createdAt: new Date('2025-01-01') },
    { ...base, id: 'a-new', tenantId: T1, status: 'EXPIRED', endDate: new Date('2026-06-01T03:00:00.000Z'), createdAt: new Date('2026-02-01') },
    { ...base, id: 'b', tenantId: T2, maxUsers: 9, createdAt: new Date('2026-01-01') },
  ] });
  const { instance } = service(prisma);
  const legacy = await instance.legacy();
  assert.equal(legacy.length, 2);
  assert.deepEqual(legacy.find(item => item.tenantId === T1), { tenantId: T1, status: 'EXPIRED', startDate: '2026-01-01T03:00:00.000Z', endDate: '2026-06-01T03:00:00.000Z', maxUsers: 1, maxAgents: 2, maxAutomations: 3, maxKnowledgeBases: 4, maxStorageBytes: '100', maxTokens: '200' });
  assert.equal(legacy.find(item => item.tenantId === T2).maxUsers, 9);
});

const auth = key => ({ headers: { authorization: 'Bearer ' + key } });
function controller() {
  const calls = [];
  const fake = { legacy: async () => [{ tenantId: T1 }], usage: async ids => { calls.push(ids); return { [ids[0]]: { users: 1 } }; } };
  return { controller: new SgdmLicensesController(fake), calls };
}

test('without a configured key the routes do not exist (404); a wrong key is 401', async () => {
  delete process.env.SGDM_INTEGRATION_KEY;
  const { controller: c } = controller();
  await assert.rejects(c.licenses(auth('x')), NotFoundException);
  await assert.rejects(c.usage(auth('x'), { tenantIds: [T1] }), NotFoundException);
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  await assert.rejects(c.licenses(auth('wrong')), UnauthorizedException);
  await assert.rejects(c.usage(auth('wrong'), { tenantIds: [T1] }), UnauthorizedException);
  await assert.rejects(c.licenses({ headers: {} }), UnauthorizedException);
});

test('GET /licencas wraps the legacy rows; POST /licencas/uso validates 1–200 uuids', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const { controller: c, calls } = controller();
  assert.deepEqual(await c.licenses(auth('secret')), { licencas: [{ tenantId: T1 }] });
  const many = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  await assert.rejects(c.usage(auth('secret'), { tenantIds: many }), BadRequestException);
  await assert.rejects(c.usage(auth('secret'), { tenantIds: [] }), BadRequestException);
  await assert.rejects(c.usage(auth('secret'), { tenantIds: ['nao-uuid'] }), BadRequestException);
  await assert.rejects(c.usage(auth('secret'), {}), BadRequestException);
  await assert.rejects(c.usage(auth('secret'), null), BadRequestException);
  assert.deepEqual(await c.usage(auth('secret'), { tenantIds: [T2, T2] }), { uso: { [T2]: { users: 1 } } });
  assert.deepEqual(calls, [[T2]]);
  await c.usage(auth('secret'), { tenantIds: many.slice(0, 200) });
  assert.equal(calls[1].length, 200);
});

test('routes are GET integracoes/sgdm/licencas and POST integracoes/sgdm/licencas/uso (200)', () => {
  const { RequestMethod } = require('@nestjs/common');
  const { METHOD_METADATA, PATH_METADATA, HTTP_CODE_METADATA } = require('@nestjs/common/constants');
  assert.equal(Reflect.getMetadata(PATH_METADATA, SgdmLicensesController), 'integracoes/sgdm');
  const route = name => RequestMethod[Reflect.getMetadata(METHOD_METADATA, SgdmLicensesController.prototype[name])] + ' ' + Reflect.getMetadata(PATH_METADATA, SgdmLicensesController.prototype[name]);
  assert.equal(route('licenses'), 'GET licencas');
  assert.equal(route('usage'), 'POST licencas/uso');
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, SgdmLicensesController.prototype.usage), 200);
});

const T3 = '33333333-3333-4333-8333-333333333333';
const threeTenants = [{ id: T1, status: 'ACTIVE' }, { id: T2, status: 'ACTIVE' }, { id: T3, status: 'ACTIVE' }];

test('SGDM down (no answer) stops the round and warns once per outage; after a success it warns again', async t => {
  let mode = 'drop';
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push(request.url);
    if (mode === 'drop') return request.socket.destroy();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ licenca: licenca() }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  process.env.NODE_ENV = 'test';
  process.env.SGDM_API_URL = `http://127.0.0.1:${server.address().port}/api/v1`;
  process.env.SGDM_INTEGRATION_KEY = 'integration-secret';
  const { db, prisma } = database({ tenants: threeTenants });
  const { instance, warnings } = service(prisma);
  assert.deepEqual(await instance.syncAll(), { synced: 0 });
  assert.equal(calls.length, 1);
  await instance.syncAll();
  assert.equal(calls.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SGDM indisponível/);
  mode = 'ok';
  assert.deepEqual(await instance.syncAll(), { synced: 3 });
  assert.equal(db.licenses.length, 3);
  mode = 'drop';
  await instance.syncAll();
  assert.equal(warnings.length, 2);
});

test('HTTP 5xx also counts as SGDM down and stops the round', async t => {
  const calls = await sgdm(t, () => [503, {}]);
  const { prisma } = database({ tenants: threeTenants });
  const { instance, warnings } = service(prisma);
  await instance.syncAll();
  await instance.syncAll();
  assert.equal(calls.length, 2);
  assert.equal(warnings.length, 1);
});

test('404 (tenant unknown to SGDM) is quiet: one warning per tenant, the round goes on, nothing changes', async t => {
  const calls = await sgdm(t, url => url.endsWith(T1) ? [404, {}] : [200, { licenca: licenca() }]);
  const local = { id: 'local', tenantId: T1, status: 'ACTIVE', maxUsers: 3, createdAt: new Date('2026-01-01') };
  const { db, prisma } = database({ tenants: threeTenants, licenses: [local] });
  const { instance, warnings } = service(prisma);
  assert.deepEqual(await instance.syncAll(), { synced: 2 });
  assert.deepEqual(await instance.syncAll(), { synced: 2 });
  assert.equal(calls.length, 6);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /404/);
  assert.deepEqual(db.licenses.find(item => item.id === 'local'), local);
});

test('counts above the contract (1.000.000, inside int4) and endDate not after startDate are malformed', async t => {
  let reply = licenca({ maxUsers: 1000001 });
  await sgdm(t, () => [200, { licenca: reply }]);
  const { prisma } = database();
  const { instance } = service(prisma);
  assert.equal(await instance.fetch(T1), undefined);
  reply = licenca({ maxKnowledgeBases: 2 ** 31 });
  assert.equal(await instance.fetch(T1), undefined);
  reply = licenca({ endDate: '2026-01-01T03:00:00.000Z' });
  assert.equal(await instance.fetch(T1), undefined);
  reply = licenca({ endDate: '2025-12-31T03:00:00.000Z' });
  assert.equal(await instance.fetch(T1), undefined);
  reply = licenca({ maxUsers: 1000000, endDate: '2026-01-02T03:00:00.000Z' });
  assert.equal((await instance.fetch(T1)).maxUsers, 1000000);
});
