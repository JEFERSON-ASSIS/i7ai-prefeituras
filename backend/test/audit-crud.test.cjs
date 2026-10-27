require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentsService } = require('../dist/agents/agents.service');
const { AgentsController } = require('../dist/agents/agents.controller');
const { ToolsService } = require('../dist/tools/tools.service');
const { ToolsController } = require('../dist/tools/tools.controller');
const { CatalogService } = require('../dist/catalog/catalog.service');
const { CatalogController } = require('../dist/catalog/catalog.controller');

const tenantId = 'tenant-a', actorId = 'actor-a';
function fixture({ auditFailure = false, seededRoles = [] } = {}) {
  let state = { agents: [], tools: [], users: [{ id: 'user-existing', tenantId, status: 'ACTIVE', roles: seededRoles.map(roleId => ({ roleId })) }, { id: actorId, tenantId, status: 'ACTIVE', roles: [] }], departments: [], licenses: [], tenant: { id: tenantId, settings: {} }, audits: [] };
  const copy = value => structuredClone(value);
  const prisma = {
    userRole: { findFirst: async () => ({ roleId: 'super-admin' }) },
    tenant: { findUnique: async () => copy(state.tenant) },
    license: { findFirst: async () => copy(state.licenses.at(-1) ?? null) },
    user: { count: async () => state.users.length }, agent: { count: async () => state.agents.length },
    automation: { count: async () => 0 }, knowledgeBase: { count: async () => 0 },
    document: { aggregate: async () => ({ _sum: { sizeBytes: 0n } }) },
    aiUsage: { aggregate: async () => ({ _sum: { inputTokens: 0, outputTokens: 0 } }) },
    aiTokenReservation: { aggregate: async () => ({ _sum: { reservedTokens: 0n } }) },
    $transaction: async (run) => {
      const staged = copy(state);
      const table = (key, render = value => value) => ({
        findFirst: async query => copy(staged[key].find(record => record.id === query.where.id && (!query.where.tenantId || record.tenantId === query.where.tenantId)) ?? null),
        count: async () => staged[key].length,
        create: async query => {
          const defaults = key === 'licenses' ? { status: 'ACTIVE', startDate: new Date('2020-01-01'), endDate: null, maxUsers: 100, maxAgents: 100, maxAutomations: 100, maxKnowledgeBases: 100, maxStorageBytes: 1000000n, maxTokens: 1000000n } : {};
          const record = { id: `${key}-${staged[key].length + 1}`, ...defaults, ...Object.fromEntries(Object.entries(copy(query.data)).filter(([, value]) => value !== undefined)) };
          staged[key].push(record); return copy(render(record));
        },
        update: async query => {
          const record = staged[key].find(item => item.id === query.where.id);
          Object.assign(record, Object.fromEntries(Object.entries(copy(query.data)).filter(([, value]) => value !== undefined)));
          return copy(render(record));
        },
      });
      const tx = {
        $queryRaw: async () => [], license: table('licenses'), department: table('departments'),
        agent: table('agents', record => ({ ...record, models: [], tools: [], knowledgeBases: [] })),
        tool: table('tools'),
        user: table('users', record => ({ id: record.id, tenantId: record.tenantId, status: record.status, roles: Array.isArray(record.roles) ? record.roles : record.roles?.create ?? [] })),
        role: { findMany: async query => query.where.id.in.map(id => ({ id, name: 'EDITOR' })) },
        userRole: { findFirst: async () => null,
          deleteMany: async query => { staged.users.find(item => item.id === query.where.userId).roles = []; },
          createMany: async query => { for (const binding of query.data) staged.users.find(item => item.id === binding.userId).roles.push({ roleId: binding.roleId }); },
        },
        tenant: {
          findUnique: async () => copy(staged.tenant),
          update: async query => { Object.assign(staged.tenant, copy(query.data)); return copy(staged.tenant); },
        },
        auditLog: { create: async query => {
          if (auditFailure) throw new Error('audit unavailable');
          staged.audits.push(copy(query.data)); return query.data;
        } },
      };
      tx.license.findFirst = async () => copy(staged.licenses.at(-1) ?? null);
      const result = await run(tx); state = staged; return result;
    },
  };
  return { prisma, state: () => state, agents: new AgentsService(prisma), tools: new ToolsService(prisma), catalog: new CatalogService(prisma) };
}
function assertAudit(record, event, resource, resourceId) {
  assert.deepEqual({ tenantId: record.tenantId, userId: record.userId, event: record.event, resource: record.resource, resourceId: record.resourceId }, { tenantId, userId: actorId, event, resource, resourceId });
}

test('agent creation and update audit actor and tenant without storing prompts or descriptions', async () => {
  const f = fixture();
  const agent = await f.agents.create(tenantId, { name: 'Agent', status: 'ARCHIVED', systemPrompt: 'private-instruction', description: 'private-description' }, actorId);
  await f.agents.update(tenantId, agent.id, { systemPrompt: 'another-private-instruction' }, actorId);
  assertAudit(f.state().audits[0], 'agent.created', 'agents', agent.id);
  assertAudit(f.state().audits[1], 'agent.updated', 'agents', agent.id);
  assert.ok(!JSON.stringify(f.state().audits).includes('private'));
});

test('tool creation and update audits omit configuration, body and credential references', async () => {
  const f = fixture();
  const tool = await f.tools.create(tenantId, { name: 'Tool', type: 'HTTP_REQUEST', allowedDomains: ['example.test'], config: { endpoint: 'https://example.test/private-path', body: { value: 'private-body' } }, credentials: [{ label: 'Authorization', secretRef: 'env:TOOL_SECRET_PRIVATE' }] }, actorId);
  await f.tools.update(tenantId, tool.id, { description: 'private-description' }, actorId);
  assertAudit(f.state().audits[0], 'tool.created', 'tools', tool.id);
  assertAudit(f.state().audits[1], 'tool.updated', 'tools', tool.id);
  assert.deepEqual(f.state().audits[0].metadata, { type: 'HTTP_REQUEST', status: 'ACTIVE' });
  assert.ok(!/private|secret|Authorization/i.test(JSON.stringify(f.state().audits)));
});

test('license creation and update audit the platform administrator and affected license', async () => {
  const f = fixture();
  await f.catalog.updateLicense(tenantId, { status: 'ACTIVE', startDate: '2020-01-01T00:00:00.000Z' }, actorId);
  const id = f.state().licenses[0].id;
  await f.catalog.updateLicense(tenantId, { maxUsers: 10 }, actorId);
  assertAudit(f.state().audits[0], 'license.created', 'licensing', id);
  assertAudit(f.state().audits[1], 'license.updated', 'licensing', id);
});

test('audit write failure rejects each mutation and rolls back its transaction', async () => {
  const mutations = [
    f => f.agents.create(tenantId, { name: 'Agent', status: 'ARCHIVED', systemPrompt: 'Help' }, actorId),
    f => f.tools.create(tenantId, { name: 'Tool', type: 'HTTP_REQUEST', allowedDomains: ['example.test'], config: { endpoint: 'https://example.test' } }, actorId),
    f => f.catalog.updateLicense(tenantId, { status: 'ACTIVE' }, actorId),
  ];
  for (const mutate of mutations) {
    const f = fixture({ auditFailure: true, seededRoles: ['old-role'] }); const before = structuredClone(f.state());
    await assert.rejects(mutate(f), /audit unavailable/);
    assert.deepEqual(f.state(), before);
  }
});

test('controllers pass authenticated actor IDs to every audited CRUD mutation', () => {
  const req = { user: { tenantId, sub: actorId } }, calls = [];
  const spy = new Proxy({}, { get: (_, operation) => (...args) => calls.push({ operation, args }) });
  const agents = new AgentsController(spy), tools = new ToolsController(spy), catalog = new CatalogController(spy);
  agents.create(req, {}); agents.update(req, 'agent', {});
  tools.create(req, {}); tools.update(req, 'tool', {});
  catalog.updateLicense(req, {});
  assert.equal(calls.length, 5);
  for (const { args } of calls) { assert.equal(args[0], tenantId); assert.equal(args.at(-1), actorId); }
});

test('users, departments and settings come from SGDM: their write handlers no longer exist', () => {
  const { RequestMethod } = require('@nestjs/common');
  const { METHOD_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
  for (const name of ['updateSettings', 'createDepartment', 'updateDepartment', 'createUser', 'updateUser']) {
    assert.equal(CatalogController.prototype[name], undefined, 'controller ' + name);
    assert.equal(CatalogService.prototype[name], undefined, 'service ' + name);
  }
  assert.equal(CatalogService.prototype.validateUserRelations, undefined);
  const routes = Object.getOwnPropertyNames(CatalogController.prototype)
    .map(name => CatalogController.prototype[name])
    .filter(handler => typeof handler === 'function' && Reflect.getMetadata(PATH_METADATA, handler) !== undefined)
    .map(handler => RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)] + ' ' + Reflect.getMetadata(PATH_METADATA, handler));
  for (const path of ['settings', 'departments', 'users', 'roles']) assert.ok(routes.includes('GET ' + path), path);
  for (const route of routes.filter(route => !route.startsWith('GET '))) assert.ok(!/settings|departments|users/.test(route), route);
  const dto = require('../dist/catalog/catalog.dto');
  for (const name of ['SettingsDto', 'DepartmentDto', 'UpdateDepartmentDto', 'CreateUserDto', 'UpdateUserDto']) assert.equal(dto[name], undefined, name);
});
