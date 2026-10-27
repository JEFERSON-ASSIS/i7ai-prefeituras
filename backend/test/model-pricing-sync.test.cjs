const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('reflect-metadata');
const { ServiceUnavailableException } = require('@nestjs/common');
const { ModelPricingSyncService } = require('../dist/ai/model-pricing-sync.service');

const envKeys = ['OMNIROUTER_BASE_URL', 'OMNIROUTER_API_KEY', 'LITELLM_ADMIN_URL', 'LITELLM_ADMIN_KEY', 'NODE_ENV'];
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
