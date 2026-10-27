const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('reflect-metadata');
const { ServiceUnavailableException } = require('@nestjs/common');
const { ModelPricingSyncService } = require('../dist/ai/model-pricing-sync.service');

const envKeys = ['OMNIROUTER_BASE_URL', 'OMNIROUTER_API_KEY', 'LITELLM_ADMIN_URL', 'LITELLM_ADMIN_KEY', 'NODE_ENV', 'SGDM_API_URL', 'SGDM_INTEGRATION_KEY'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
test.afterEach(() => envKeys.forEach(key => savedEnv[key] === undefined ? delete process.env[key] : process.env[key] = savedEnv[key]));

async function gateway(t, status, payload) {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ method: request.method, url: request.url, auth: request.headers.authorization });
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  process.env.NODE_ENV = 'test';
  process.env.OMNIROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.OMNIROUTER_API_KEY = 'sk-master';
  delete process.env.LITELLM_ADMIN_URL; delete process.env.LITELLM_ADMIN_KEY;
  return calls;
}

function fakePrisma() {
  const rows = [
    { id: 'm1', slug: 'openai/gpt-4o-mini', inputPrice: null, outputPrice: null, cachedInputPrice: null, capabilities: { vision: true } },
    { id: 'm2', slug: 'google/gemini-x', inputPrice: '9.000000', outputPrice: '9.000000', cachedInputPrice: '9.000000', capabilities: null },
    { id: 'm3', slug: 'anthropic/x', inputPrice: '1.000000', outputPrice: '2.000000', cachedInputPrice: null, capabilities: {} },
  ];
  return {
    rows,
    aiModel: {
      findMany: async () => rows.map(row => ({ id: row.id, slug: row.slug, capabilities: row.capabilities })),
      update: async ({ where, data }) => Object.assign(rows.find(row => row.id === where.id), data),
    },
  };
}

test('sync grava preços em USD por milhão, cache e contexto; ignora curinga', async t => {
  const calls = await gateway(t, 200, { data: [
    { model_name: 'openai/gpt-4o-mini', model_info: { input_cost_per_token: 0.00000015, output_cost_per_token: 0.0000006, cache_read_input_token_cost: 0.000000075, max_input_tokens: 128000 } },
    { model_name: 'google/gemini-x', model_info: { input_cost_per_token: 0.000001, output_cost_per_token: 0.000004, max_input_tokens: 'x' } },
    { model_name: 'openai/*', model_info: { input_cost_per_token: 1, output_cost_per_token: 1 } },
  ] });
  const prisma = fakePrisma();
  const result = await new ModelPricingSyncService(prisma).sync();
  assert.deepEqual(result, { updated: 2, unknown: ['anthropic/x'] });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, '/model/info');
  assert.equal(calls[0].auth, 'Bearer sk-master');
  const [a, b, c] = prisma.rows;
  assert.deepEqual([a.inputPrice, a.outputPrice, a.cachedInputPrice], ['0.150000', '0.600000', '0.075000']);
  assert.deepEqual(a.capabilities, { vision: true, contextWindow: 128000 });
  assert.deepEqual([b.inputPrice, b.outputPrice, b.cachedInputPrice], ['1.000000', '4.000000', null]);
  assert.equal(b.capabilities, null);
  assert.deepEqual([c.inputPrice, c.outputPrice], ['1.000000', '2.000000']);
});

test('sync com erro HTTP lança ServiceUnavailableException e não altera nada', async t => {
  await gateway(t, 500, { error: { message: 'boom' } });
  const prisma = fakePrisma();
  const before = JSON.stringify(prisma.rows);
  await assert.rejects(() => new ModelPricingSyncService(prisma).sync(), ServiceUnavailableException);
  assert.equal(JSON.stringify(prisma.rows), before);
});

test('sync preenche a janela de contexto só quando vazia; nunca sobrescreve a configurada', async t => {
  await gateway(t, 200, { data: [
    { model_name: 'openai/gpt-4o-mini', model_info: { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002, max_input_tokens: 1_050_000 } },
    { model_name: 'google/gemini-x', model_info: { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002, max_input_tokens: 1_050_000 } },
  ] });
  const prisma = fakePrisma();
  prisma.rows[0].capabilities = { vision: true, contextWindow: 128000 };
  await new ModelPricingSyncService(prisma).sync();
  assert.deepEqual(prisma.rows[0].capabilities, { vision: true, contextWindow: 128000 });
  assert.equal(prisma.rows[0].inputPrice, '1.000000');
  assert.deepEqual(prisma.rows[1].capabilities, { contextWindow: 1_050_000 });
});

test('execução agendada registra o motivo da falha e os modelos sem preço, sem a chave', async t => {
  const logs = [];
  const capture = service => { service.logger = { warn: m => logs.push(['warn', m]), error: m => logs.push(['error', m]) }; return service; };
  await gateway(t, 200, { data: [{ model_name: 'openai/gpt-4o-mini', model_info: { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 } }] });
  await capture(new ModelPricingSyncService(fakePrisma())).runScheduled();
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'warn');
  assert.match(logs[0][1], /google\/gemini-x, anthropic\/x/);
  logs.length = 0;
  await gateway(t, 500, { error: { message: 'boom' } });
  await capture(new ModelPricingSyncService(fakePrisma())).runScheduled();
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'error');
  assert.match(logs[0][1], /Não foi possível ler os preços no gateway de IA/);
  assert.ok(!logs.some(([, message]) => message.includes('sk-master')));
});

async function sgdmCatalog(t, payload, status = 200) {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ url: request.url, auth: request.headers.authorization });
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  process.env.NODE_ENV = 'test';
  process.env.SGDM_API_URL = `http://127.0.0.1:${server.address().port}/api/v1`;
  process.env.SGDM_INTEGRATION_KEY = 'integration-secret';
  return calls;
}

function catalogPrisma() {
  const providers = [{ id: 'p-openai', slug: 'openai', name: 'OpenAI' }];
  const rows = [
    { id: 'm1', providerId: 'p-openai', slug: 'openai/gpt-5.5', name: 'gpt-5.5 antigo', inputPrice: '1.250000', outputPrice: '10.000000', cachedInputPrice: '0.125000', active: true, capabilities: { contextWindow: 400000, custom: 'x' } },
    { id: 'm2', providerId: 'p-openai', slug: 'openai/gpt-4o-mini', name: 'gpt-4o-mini', inputPrice: '0.150000', outputPrice: '0.600000', cachedInputPrice: null, active: true, capabilities: null },
  ];
  const writes = [];
  const matches = (row, where) => row.providerId === where.providerId_slug.providerId && row.slug === where.providerId_slug.slug;
  return {
    providers, rows, writes,
    aiProvider: { upsert: async ({ where, create }) => { writes.push(['provider', create]); let row = providers.find(item => item.slug === where.slug); if (!row) { row = { id: 'p-' + create.slug, ...create }; providers.push(row); } return row; } },
    aiModel: {
      findMany: async () => rows.map(row => ({ id: row.id, slug: row.slug, capabilities: row.capabilities })),
      findUnique: async ({ where }) => rows.find(row => matches(row, where)) || null,
      upsert: async ({ where, create, update }) => {
        writes.push(['model', create, update]);
        const row = rows.find(item => matches(item, where));
        if (row) return Object.assign(row, update);
        const created = { id: 'm' + (rows.length + 1), inputPrice: null, outputPrice: null, cachedInputPrice: null, ...create };
        rows.push(created); return created;
      },
      updateMany: async ({ where, data }) => {
        const hit = rows.filter(row => row.active === where.active && !where.id.notIn.includes(row.id));
        hit.forEach(row => Object.assign(row, data)); return { count: hit.length };
      },
      update: async ({ where, data }) => Object.assign(rows.find(row => row.id === where.id), data),
    },
  };
}

const sgdmModels = { modelos: [
  { slug: 'openai/gpt-5.5', nome: 'gpt-5.5', provedor: 'openai', padrao: true, capacidades: { contextWindow: 1000000, maxOutputTokens: 128000, supportsVision: true, supportsTools: true, supportsReasoning: true, supportsPromptCaching: true } },
  { slug: 'anthropic/claude-sonnet-5', nome: 'claude-sonnet-5', provedor: 'anthropic', padrao: false, capacidades: { contextWindow: 200000, maxOutputTokens: 64000, supportsVision: true, supportsTools: true, supportsReasoning: false, supportsPromptCaching: true } },
] };

test('syncCatalog cria provedor e modelo ausentes e atualiza o existente', async t => {
  const calls = await sgdmCatalog(t, sgdmModels);
  const prisma = catalogPrisma();
  const result = await new ModelPricingSyncService(prisma).syncCatalog();
  assert.deepEqual(result, { upserted: 2, deactivated: 1 });
  assert.equal(calls[0].url, '/api/v1/integracoes/i7ai/modelos');
  assert.equal(calls[0].auth, 'Bearer integration-secret');
  const anthropic = prisma.providers.find(item => item.slug === 'anthropic');
  assert.equal(anthropic.name, 'Anthropic (Claude)');
  const created = prisma.rows.find(row => row.slug === 'anthropic/claude-sonnet-5');
  assert.equal(created.providerId, anthropic.id);
  assert.equal(created.name, 'claude-sonnet-5');
  assert.equal(created.active, true);
  // LiteLLM owns the context window: the SGDM catalog never writes it.
  assert.deepEqual(created.capabilities, { maxOutputTokens: 64000, supportsVision: true, supportsTools: true, supportsReasoning: false, supportsPromptCaching: true });
  const updated = prisma.rows.find(row => row.id === 'm1');
  assert.equal(updated.name, 'gpt-5.5');
  assert.deepEqual(updated.capabilities, { contextWindow: 400000, custom: 'x', maxOutputTokens: 128000, supportsVision: true, supportsTools: true, supportsReasoning: true, supportsPromptCaching: true });
});

test('syncCatalog marca active:false o modelo que saiu, sem apagar', async t => {
  await sgdmCatalog(t, sgdmModels);
  const prisma = catalogPrisma();
  await new ModelPricingSyncService(prisma).syncCatalog();
  const gone = prisma.rows.find(row => row.id === 'm2');
  assert.ok(gone, 'nunca apaga');
  assert.equal(gone.active, false);
  // Running again does not count it twice.
  assert.deepEqual(await new ModelPricingSyncService(prisma).syncCatalog(), { upserted: 2, deactivated: 0 });
});

test('syncCatalog não sobrescreve preços', async t => {
  await sgdmCatalog(t, { modelos: [{ ...sgdmModels.modelos[0], inputPrice: 99, outputPrice: 99 }] });
  const prisma = catalogPrisma();
  await new ModelPricingSyncService(prisma).syncCatalog();
  const row = prisma.rows.find(item => item.id === 'm1');
  assert.deepEqual([row.inputPrice, row.outputPrice, row.cachedInputPrice], ['1.250000', '10.000000', '0.125000']);
  for (const [kind, create, update] of prisma.writes) {
    if (kind !== 'model') continue;
    for (const data of [create, update]) for (const field of ['inputPrice', 'outputPrice', 'cachedInputPrice']) assert.equal(field in data, false);
  }
});

test('syncCatalog com resposta inválida ou SGDM fora não desativa nada', async t => {
  await sgdmCatalog(t, { modelos: 'x' });
  const prisma = catalogPrisma();
  await assert.rejects(new ModelPricingSyncService(prisma).syncCatalog(), ServiceUnavailableException);
  await sgdmCatalog(t, { message: 'boom' }, 500);
  await assert.rejects(new ModelPricingSyncService(prisma).syncCatalog());
  assert.ok(prisma.rows.every(row => row.active));
});

test('rodada agendada: catálogo do SGDM e depois preços; sem integração, só preços', async t => {
  await gateway(t, 200, { data: [] });
  await sgdmCatalog(t, sgdmModels);
  const order = [];
  const service = new ModelPricingSyncService(catalogPrisma());
  service.logger = { warn: () => {}, error: () => {}, log: () => {} };
  service.syncCatalog = async () => { order.push('catalog'); return { upserted: 0, deactivated: 0 }; };
  service.sync = async () => { order.push('prices'); return { updated: 0, unknown: [] }; };
  await service.runScheduled();
  assert.deepEqual(order, ['catalog', 'prices']);
  order.length = 0;
  service.syncCatalog = async () => { order.push('catalog'); throw new Error('SGDM fora'); };
  await service.runScheduled();
  assert.deepEqual(order, ['catalog', 'prices'], 'falha do catálogo não impede os preços');
  order.length = 0;
  delete process.env.SGDM_INTEGRATION_KEY;
  await service.runScheduled();
  assert.deepEqual(order, ['prices']);
});
