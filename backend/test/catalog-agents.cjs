require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentsService } = require('../dist/agents/agents.service');
const { CatalogService } = require('../dist/catalog/catalog.service');
const { assertLicenseCapacity, assertActiveLicense, requireActiveLicense, assertStorageCapacity } = require('../dist/catalog/license-policy');

async function withAgentRoutingEnvironment(configuration, action) {
  const previous = { ...process.env };
  for (const key of ['OMNIROUTER_BASE_URL', 'OMNIROUTER_API_KEY', 'AI_GATEWAY_URL', 'AI_GATEWAY_API_KEY']) delete process.env[key];
  Object.assign(process.env, configuration);
  try { return await action(); }
  finally {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

function reasoningAgentTransaction(advancedReasoning = false) {
  const writes = [], creates = [], updates = [];
  let agent = { id: 'agent', tenantId: 'tenant-a', name: 'Agent', status: 'DRAFT', temperature: 0.2, advancedReasoning, models: [], tools: [], knowledgeBases: [] };
  const mutation = (operation) => async () => { writes.push(operation); return {}; };
  const tx = {
    $queryRaw: async () => [],
    license: { findFirst: async () => ({ status: 'ACTIVE', startDate: new Date('2020-01-01'), endDate: null, maxAgents: 10 }) },
    agent: {
      count: async () => 0,
      findFirst: async () => agent,
      create: async ({ data }) => {
        writes.push('agent.create'); creates.push(data);
        agent = { ...agent, ...data, models: [], tools: [], knowledgeBases: [] };
        return agent;
      },
      update: async ({ data }) => {
        writes.push('agent.update'); updates.push(data);
        agent = { ...agent, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) };
        return agent;
      },
    },
    aiModel: { findUnique: async ({ where }) => ({ id: where.id }) },
    knowledgeBase: { count: async ({ where }) => where.id.in.length },
    tool: { count: async ({ where }) => where.id.in.length },
    agentModel: { deleteMany: mutation('models.delete'), create: mutation('models.create') },
    agentKnowledgeBase: { deleteMany: mutation('knowledge.delete'), createMany: mutation('knowledge.create') },
    agentTool: { deleteMany: mutation('tools.delete'), createMany: mutation('tools.create') },
    auditLog: { create: mutation('audit.create') },
  };
  return { tx, writes, creates, updates };
}

const reasoningBindings = { modelId: 'model', knowledgeBaseIds: ['base'], toolIds: ['tool'] };
const omniRoutingConfigurations = [
  ['OMNIROUTER_BASE_URL', { OMNIROUTER_BASE_URL: 'https://omniroute.example.test/v1' }],
  ['OMNIROUTER_API_KEY', { OMNIROUTER_API_KEY: 'test-only-omniroute-key' }],
];

for (const [variable, configuration] of omniRoutingConfigurations) {
  test(`agent create rejects advanced reasoning when only ${variable} configures OmniRoute before mutations`, async () => {
    await withAgentRoutingEnvironment(configuration, async () => {
      const { tx, writes } = reasoningAgentTransaction();
      const service = new AgentsService({ $transaction: (fn) => fn(tx) });
      await assert.rejects(service.create('tenant-a', { name: 'Agent', systemPrompt: 'Help', advancedReasoning: true, ...reasoningBindings }), (error) => error.getStatus?.() === 400);
      assert.deepEqual(writes, []);
    });
  });

  test(`agent PATCH rejects explicit advanced reasoning with ${variable} before binding, agent and audit mutations`, async () => {
    await withAgentRoutingEnvironment(configuration, async () => {
      const { tx, writes } = reasoningAgentTransaction();
      const service = new AgentsService({ $transaction: (fn) => fn(tx) });
      await assert.rejects(service.update('tenant-a', 'agent', { name: 'Changed', advancedReasoning: true, ...reasoningBindings }), (error) => error.getStatus?.() === 400);
      assert.deepEqual(writes, []);
    });
  });

  test(`agent PATCH rejects inherited advanced reasoning with ${variable} when the field is omitted`, async () => {
    await withAgentRoutingEnvironment(configuration, async () => {
      const { tx, writes } = reasoningAgentTransaction(true);
      const service = new AgentsService({ $transaction: (fn) => fn(tx) });
      await assert.rejects(service.update('tenant-a', 'agent', { name: 'Changed', ...reasoningBindings }), (error) => error.getStatus?.() === 400);
      assert.deepEqual(writes, []);
    });
  });

  test(`agent PATCH can repair legacy advanced reasoning with ${variable} by explicitly disabling it`, async () => {
    await withAgentRoutingEnvironment(configuration, async () => {
      const { tx, writes, updates } = reasoningAgentTransaction(true);
      const service = new AgentsService({ $transaction: (fn) => fn(tx) });
      const result = await service.update('tenant-a', 'agent', { advancedReasoning: false, ...reasoningBindings });
      assert.equal(result.advancedReasoning, false);
      assert.equal(updates[0].advancedReasoning, false);
      assert.deepEqual(writes, ['models.delete', 'models.create', 'knowledge.delete', 'knowledge.create', 'tools.delete', 'tools.create', 'agent.update', 'audit.create']);
    });
  });

  test(`agent create permits disabled and default reasoning with ${variable}`, async () => {
    await withAgentRoutingEnvironment(configuration, async () => {
      for (const reasoningInput of [{ advancedReasoning: false }, {}]) {
        const { tx, writes, creates } = reasoningAgentTransaction();
        const service = new AgentsService({ $transaction: (fn) => fn(tx) });
        const result = await service.create('tenant-a', { name: 'Agent', systemPrompt: 'Help', ...reasoningInput });
        assert.equal(result.advancedReasoning, false);
        assert.equal(creates[0].advancedReasoning, false);
        assert.deepEqual(writes, ['agent.create', 'audit.create']);
      }
    });
  });
}

test('agent create preserves advanced reasoning outside OmniRoute with a legacy gateway configured', async () => {
  await withAgentRoutingEnvironment({ AI_GATEWAY_URL: 'https://gateway.example.test', AI_GATEWAY_API_KEY: 'test-only-gateway-key' }, async () => {
    const { tx, writes, creates } = reasoningAgentTransaction();
    const service = new AgentsService({ $transaction: (fn) => fn(tx) });
    const result = await service.create('tenant-a', { name: 'Agent', systemPrompt: 'Help', advancedReasoning: true });
    assert.equal(result.advancedReasoning, true);
    assert.equal(creates[0].advancedReasoning, true);
    assert.deepEqual(writes, ['agent.create', 'audit.create']);
  });
});

test('agent PATCH preserves explicit and inherited advanced reasoning outside OmniRoute', async () => {
  await withAgentRoutingEnvironment({}, async () => {
    for (const [existingReasoning, input] of [[false, { advancedReasoning: true }], [true, {}]]) {
      const { tx, writes, updates } = reasoningAgentTransaction(existingReasoning);
      const service = new AgentsService({ $transaction: (fn) => fn(tx) });
      const result = await service.update('tenant-a', 'agent', { name: 'Changed', ...input });
      assert.equal(result.advancedReasoning, true);
      assert.equal(updates[0].advancedReasoning, input.advancedReasoning);
      assert.deepEqual(writes, ['agent.update', 'audit.create']);
    }
  });
});

test('agent PATCH denies foreign knowledge bases before deleting bindings', async () => {
  let writes = 0;
  const tx = { agent: { findFirst: async () => ({ id: 'agent' }) }, knowledgeBase: { count: async (query) => { assert.equal(query.where.tenantId, 'tenant-a'); return 0; } }, agentKnowledgeBase: { deleteMany: async () => { writes++; } } };
  const service = new AgentsService({ $transaction: (fn) => fn(tx) });
  await assert.rejects(service.update('tenant-a', 'agent', { knowledgeBaseIds: ['foreign-base'] }), /bases não pertencem/);
  assert.equal(writes, 0);
});

test('agent PATCH denies foreign tools before deleting bindings', async () => {
  let writes = 0;
  const tx = { agent: { findFirst: async () => ({ id: 'agent' }) }, tool: { count: async (query) => { assert.equal(query.where.tenantId, 'tenant-a'); return 0; } }, agentTool: { deleteMany: async () => { writes++; } } };
  const service = new AgentsService({ $transaction: (fn) => fn(tx) });
  await assert.rejects(service.update('tenant-a', 'agent', { toolIds: ['foreign-tool'] }), /ferramentas não pertencem/);
  assert.equal(writes, 0);
});

test('agent PATCH scopes the agent lookup to its tenant', async () => {
  const tx = { agent: { findFirst: async (query) => { assert.deepEqual(query.where, { id: 'foreign-agent', tenantId: 'tenant-a' }); return null; } } };
  const service = new AgentsService({ $transaction: (fn) => fn(tx) });
  await assert.rejects(service.update('tenant-a', 'foreign-agent', { name: 'Changed' }), /Agente não encontrado/);
});

test('agent create denies a foreign department without creating an agent', async () => {
  let writes = 0;
  const tx = { department: { findFirst: async (query) => { assert.equal(query.where.tenantId, 'tenant-a'); return null; } }, agent: { create: async () => { writes++; } } };
  const service = new AgentsService({ $transaction: (fn) => fn(tx) });
  await assert.rejects(service.create('tenant-a', { name: 'Agent', systemPrompt: 'Help', departmentId: 'foreign-department' }), /Departamento não pertence/);
  assert.equal(writes, 0);
});

test('user listing selects no password hash', async () => {
  const service = new CatalogService({ user: { findMany: async (query) => { assert.equal(query.where.tenantId, 'tenant-a'); assert.equal(query.select.passwordHash, undefined); return []; } } });
  assert.deepEqual(await service.users('tenant-a'), []);
});

function licenseTransaction(overrides = {}) {
  const events = [];
  const tx = { $queryRaw: async (query) => { assert.match(query.sql, /FOR UPDATE/); events.push('lock'); },
    license: { findFirst: async () => { events.push('license'); return { status: 'ACTIVE', startDate: new Date('2020-01-01'), endDate: null, maxUsers: 2, maxAgents: 2, ...overrides }; } },
    user: { count: async (query) => { assert.deepEqual(query.where.status, { not: 'SUSPENDED' }); events.push('count'); return 2; } },
    agent: { count: async (query) => { assert.deepEqual(query.where.status, { not: 'ARCHIVED' }); events.push('count'); return 2; } },
    auditLog: { create: async () => ({}) } };
  return { tx, events };
}

test('license caps serialize tenant allocation before counting users and agents', async () => {
  for (const resource of ['users', 'agents']) {
    const { tx, events } = licenseTransaction();
    await assert.rejects(assertLicenseCapacity(tx, 'tenant-a', resource), /Limite de .* da licença atingido/);
    assert.deepEqual(events, ['lock', 'license', 'count']);
  }
});

test('expired, suspended and future licenses deny new allocations', async () => {
  for (const override of [{ endDate: new Date('2000-01-01') }, { status: 'SUSPENDED' }, { startDate: new Date('2100-01-01') }]) {
    const { tx, events } = licenseTransaction(override);
    await assert.rejects(assertLicenseCapacity(tx, 'tenant-a', 'agents'), /Licença da prefeitura/);
    assert.deepEqual(events, ['lock', 'license']);
  }
});

test('production rejects new allocations without a license', async () => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try { await assert.rejects(assertLicenseCapacity({ $queryRaw: async () => [], license: { findFirst: async () => null } }, 'tenant-a', 'users'), /sem licença ativa/); }
  finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('archived agent reactivation cannot bypass capacity', async () => {
  const { tx } = licenseTransaction(); let writes = 0;
  tx.agent.findFirst = async () => ({ id: 'agent', status: 'ARCHIVED' }); tx.agent.update = async () => { writes++; };
  const service = new AgentsService({ $transaction: (fn) => fn(tx) });
  await assert.rejects(service.update('tenant-a', 'agent', { status: 'ACTIVE' }), /Limite de agentes/);
  assert.equal(writes, 0);
});

test('automation capacity excludes the current automation during activation', async () => {
  const { tx, events } = licenseTransaction({ maxAutomations: 2 });
  tx.automation = { count: async (query) => { assert.deepEqual(query.where, { tenantId: 'tenant-a', status: { not: 'ARCHIVED' }, id: { not: 'own-automation' } }); events.push('count'); return 1; } };
  await assertLicenseCapacity(tx, 'tenant-a', 'automations', 'own-automation');
  assert.deepEqual(events, ['lock', 'license', 'count']);
});

test('knowledge base capacity denies allocations at the licensed limit', async () => {
  const { tx } = licenseTransaction({ maxKnowledgeBases: 2 });
  tx.knowledgeBase = { count: async (query) => { assert.deepEqual(query.where, { tenantId: 'tenant-a' }); return 2; } };
  await assert.rejects(assertLicenseCapacity(tx, 'tenant-a', 'knowledgeBases'), /Limite de bases de conhecimento/);
});

test('storage reservations serialize tenant allocation and allow exact quota', async () => {
  const { tx, events } = licenseTransaction({ maxStorageBytes: 100n });
  tx.document = { aggregate: async (query) => { assert.equal(query.where.tenantId, 'tenant-a'); events.push('storage'); return { _sum: { sizeBytes: 80n } }; } };
  await assertStorageCapacity(tx, 'tenant-a', 20n);
  assert.deepEqual(events, ['lock', 'license', 'storage']);
  await assert.rejects(assertStorageCapacity(tx, 'tenant-a', 21n), /Limite de armazenamento/);
  await assert.rejects(assertStorageCapacity(tx, 'tenant-a', -1n), /Tamanho de armazenamento/);
});

test('active license read helpers share the same expiry policy without acquiring a write lock', async () => {
  const { tx } = licenseTransaction({ endDate: new Date('2000-01-01') });
  assert.equal(requireActiveLicense, assertActiveLicense);
  await assert.rejects(requireActiveLicense({ license: tx.license }, 'tenant-a'), /Licença da prefeitura/);
});

test('agent create and update refuse an inactive model with a 400', async () => {
  const { tx, writes } = reasoningAgentTransaction();
  tx.aiModel.findUnique = async ({ where }) => ({ id: where.id, active: where.id !== 'off' });
  const service = new AgentsService({ $transaction: (fn) => fn(tx) });
  await assert.rejects(service.create('tenant-a', { name: 'A', systemPrompt: 'x', modelId: 'off' }), /Este modelo não está ativo na plataforma/);
  await assert.rejects(service.update('tenant-a', 'agent', { modelId: 'off' }), /Este modelo não está ativo na plataforma/);
  assert.ok(!writes.includes('agent.create') && !writes.includes('models.create'));
  await service.update('tenant-a', 'agent', { modelId: 'on' });
  assert.ok(writes.includes('models.create'));
});

test('GET /departments returns active ones plus the agent current department', async () => {
  let where;
  const service = new CatalogService({ department: { findMany: async (query) => { where = query.where; return []; } } });
  await service.departments('tenant-a');
  assert.deepEqual(where, { tenantId: 'tenant-a', OR: [{ status: 'ACTIVE' }] });
  await service.departments('tenant-a', 'dep-1');
  assert.deepEqual(where, { tenantId: 'tenant-a', OR: [{ status: 'ACTIVE' }, { id: 'dep-1' }] });
});
