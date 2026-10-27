const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('reflect-metadata');
const { TenantAiKeyService } = require('../dist/ai/tenant-ai-key.service');

const TENANT = '00000000-0000-0000-0000-000000000001';
const envKeys = ['SGDM_API_URL', 'SGDM_INTEGRATION_KEY', 'SGDM_AI_KEY_CACHE_SECONDS', 'SGDM_FAILURE_CACHE_SECONDS', 'SGDM_INTERNAL_HOSTS', 'NODE_ENV'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
test.afterEach(() => envKeys.forEach(key => savedEnv[key] === undefined ? delete process.env[key] : process.env[key] = savedEnv[key]));

async function sgdm(t, reply) {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ url: request.url, auth: request.headers.authorization });
    const [status, body] = reply();
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

test('returns the SGDM key only for models of the configured provider, and caches it', async t => {
  const calls = await sgdm(t, () => [200, { habilitado: true, provedor: 'anthropic', modelo: null, apiKey: ' sk-ant-123 ' }]);
  const service = new TenantAiKeyService();
  assert.equal(await service.forModel(TENANT, 'anthropic/claude-sonnet-5-5'), 'sk-ant-123');
  assert.equal(await service.forModel(TENANT, 'openai/gpt-5.5'), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/integracoes/i7ai/ia/' + TENANT);
  assert.equal(calls[0].auth, 'Bearer integration-secret');
});

test('disabled, missing, failing or unconfigured SGDM falls back to the platform key', async t => {
  let reply = [200, { habilitado: false }];
  const calls = await sgdm(t, () => reply);
  process.env.SGDM_AI_KEY_CACHE_SECONDS = '0';
  process.env.SGDM_FAILURE_CACHE_SECONDS = '0';
  const service = new TenantAiKeyService();
  assert.equal(await service.forModel(TENANT, 'anthropic/x'), undefined);
  reply = [401, { message: 'chave' }];
  assert.equal(await service.forModel(TENANT, 'anthropic/x'), undefined);
  reply = [200, { habilitado: true, provedor: 'anthropic', apiKey: 'com espaço' }];
  assert.equal(await service.forModel(TENANT, 'anthropic/x'), undefined);
  assert.equal(await service.forModel('nao-uuid', 'anthropic/x'), undefined);
  assert.equal(calls.length, 3);
  delete process.env.SGDM_INTEGRATION_KEY;
  assert.equal(await service.forModel(TENANT, 'anthropic/x'), undefined);
  assert.equal(calls.length, 3);
});

test('a failed SGDM read is cached only for the short failure window, not for the key TTL', async t => {
  let reply = [503, { message: 'indisponível' }];
  const calls = await sgdm(t, () => reply);
  process.env.SGDM_AI_KEY_CACHE_SECONDS = '300';
  process.env.SGDM_FAILURE_CACHE_SECONDS = '0.05';
  const service = new TenantAiKeyService();
  assert.equal(await service.forModel(TENANT, 'anthropic/x'), undefined);
  assert.equal(await service.forModel(TENANT, 'anthropic/x'), undefined);
  assert.equal(calls.length, 1, 'inside the failure window SGDM is not asked again');
  await new Promise(resolve => setTimeout(resolve, 80));
  reply = [200, { habilitado: true, provedor: 'anthropic', apiKey: 'sk-ant-9' }];
  assert.equal(await service.forModel(TENANT, 'anthropic/x'), 'sk-ant-9');
  assert.equal(calls.length, 2, 'after the failure window SGDM is read again');
  reply = [503, {}];
  assert.equal(await service.forModel(TENANT, 'anthropic/x'), 'sk-ant-9');
  assert.equal(calls.length, 2, 'a good read keeps the long TTL');
});
