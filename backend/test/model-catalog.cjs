require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { CatalogService } = require('../dist/catalog/catalog.service');
const { CatalogController } = require('../dist/catalog/catalog.controller');
const { existsSync } = require('node:fs');

const providerId = '00000000-0000-4000-8000-000000000010';
const modelId = '00000000-0000-4000-8000-000000000011';

test('Modelos é só leitura: não há rotas nem métodos de escrita de modelos', () => {
  assert.equal(typeof CatalogController.prototype.createModel, 'undefined');
  assert.equal(typeof CatalogController.prototype.updateModel, 'undefined');
  assert.equal(typeof CatalogService.prototype.createModel, 'undefined');
  assert.equal(typeof CatalogService.prototype.updateModel, 'undefined');
  // The catalog no longer has any write DTO (models, users, departments, settings, license): the file is gone.
  assert.equal(existsSync(require('node:path').join(__dirname, '../src/catalog/catalog.dto.ts')), false);
  const routes = Object.getOwnPropertyNames(CatalogController.prototype)
    .map(name => [Reflect.getMetadata('path', CatalogController.prototype[name]), Reflect.getMetadata('method', CatalogController.prototype[name])])
    .filter(([path]) => typeof path === 'string' && path.startsWith('models'));
  // RequestMethod.GET === 0: only GET /models remains.
  assert.deepEqual(routes, [['models', 0]]);
});

function modelsService(access) {
  const queries = [];
  const rows = [
    { id: '1', slug: 'openai/gpt-5.5', active: true, inputPrice: null, outputPrice: null, capabilities: null, provider: { id: providerId, name: 'OpenAI', slug: 'openai' } },
    { id: '2', slug: 'anthropic/claude-sonnet-5', active: true, inputPrice: null, outputPrice: null, capabilities: null, provider: { id: providerId, name: 'Anthropic', slug: 'anthropic' } },
  ];
  const service = new CatalogService({ aiModel: { findMany: async query => { queries.push(query); return rows; } } }, access);
  return { service, queries };
}

test('GET /models devolve só ativos; SUPER_ADMIN vê todos os ativos', async () => {
  const access = { allowed: async () => { throw new Error('não deve consultar'); } };
  const { service, queries } = modelsService(access);
  const result = await service.models({ sub: 'admin', tenantId: 'tenant', roles: ['SUPER_ADMIN'] });
  assert.equal(queries[0].where.active, true);
  assert.equal(result.length, 2);
});

test('GET /models para quem não é SUPER_ADMIN devolve só os liberados para o usuário', async () => {
  const calls = [];
  const access = { allowed: async (...args) => { calls.push(args); return { slugs: ['anthropic/claude-sonnet-5'], defaultSlug: null }; } };
  const { service } = modelsService(access);
  const result = await service.models({ sub: 'user', tenantId: 'tenant', roles: ['ADMIN'] });
  assert.deepEqual(result.map(model => model.id), ['2']);
  assert.deepEqual(calls, [['tenant', 'user']]);
  // Without integration (allowed() -> null) every active model is listed.
  const local = modelsService({ allowed: async () => null });
  assert.equal((await local.service.models({ sub: 'user', tenantId: 'tenant', roles: [] })).length, 2);
});

test('provider responses expose capabilities metadata and omit config or credentials', async () => {
  const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'must-never-leak';
  const service = new CatalogService({ aiProvider: { findMany: async () => [{ id: providerId, name: 'OpenAI', slug: 'openai', config: { apiKey: 'also-private', endpoint: 'secret-endpoint', supportsReasoning: true, supportsTemperature: false } }] } });
  try {
    const result = await service.providers();
    assert.equal(result[0].capabilities.supportsReasoning, true); assert.equal(result[0].capabilities.supportsTemperature, false);
    assert.equal(result[0].config, undefined);
    assert.ok(!JSON.stringify(result).includes('must-never-leak')); assert.ok(!JSON.stringify(result).includes('also-private')); assert.ok(!JSON.stringify(result).includes('secret-endpoint'));
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});

test('provider metadata distinguishes adapter reasoning control from model reasoning and Omni precedence', async () => {
  const envKeys = ['OMNIROUTER_BASE_URL', 'OMNIROUTER_API_KEY', 'AI_GATEWAY_URL', 'AI_GATEWAY_API_KEY'];
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const cases = [
    { env: {}, slug: 'openai', supported: true },
    { env: {}, slug: 'external', supported: false },
    { env: { AI_GATEWAY_URL: 'https://fixture.invalid' }, slug: 'external', supported: true },
    { env: { OMNIROUTER_BASE_URL: 'https://fixture.invalid/v1' }, slug: 'openai', supported: false },
    { env: { OMNIROUTER_API_KEY: 'synthetic-fixture' }, slug: 'openai', supported: false },
    { env: { OMNIROUTER_BASE_URL: 'https://fixture.invalid/v1', OMNIROUTER_API_KEY: 'synthetic-fixture', AI_GATEWAY_URL: 'https://legacy.invalid' }, slug: 'external', supported: false },
  ];
  try {
    for (const { env, slug, supported } of cases) {
      envKeys.forEach(key => delete process.env[key]); Object.assign(process.env, env);
      const service = new CatalogService({ aiProvider: { findMany: async () => [{ id: providerId, name: 'Provider', slug, config: { supportsReasoning: true, apiKey: 'provider-private' } }] } });
      const [provider] = await service.providers();
      assert.equal(provider.capabilities.supportsAdvancedReasoningControl, supported);
      assert.equal(provider.capabilities.supportsReasoning, true);
      assert.ok(!JSON.stringify(provider).includes('synthetic-fixture'));
      assert.ok(!JSON.stringify(provider).includes('provider-private'));
    }
  } finally { envKeys.forEach(key => { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }); }
});

test('model catalogue exposes adapter reasoning control without inferring model reasoning or leaking provider config', async () => {
  const envKeys = ['OMNIROUTER_BASE_URL', 'OMNIROUTER_API_KEY'];
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.OMNIROUTER_BASE_URL = 'https://fixture.invalid/v1'; process.env.OMNIROUTER_API_KEY = 'synthetic-fixture';
  const model = { id: modelId, slug: 'claude-fixture', inputPrice: null, outputPrice: null, capabilities: { supportsReasoning: true }, provider: { id: providerId, name: 'Provider', slug: 'anthropic', config: { apiKey: 'provider-private' } } };
  const service = new CatalogService({ aiModel: { findMany: async () => [model] } });
  try {
    const [result] = await service.models({ sub: 'admin', tenantId: 'tenant', roles: ['SUPER_ADMIN'] });
    assert.equal(result.provider.capabilities.supportsAdvancedReasoningControl, false);
    assert.equal(result.capabilities.supportsReasoning, true);
    assert.equal(result.provider.config, undefined);
    assert.ok(!JSON.stringify(result).includes('synthetic-fixture'));
    assert.ok(!JSON.stringify(result).includes('provider-private'));
  } finally { envKeys.forEach(key => { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }); }
});
