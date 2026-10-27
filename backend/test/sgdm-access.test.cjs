const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('reflect-metadata');
const { ForbiddenException, ServiceUnavailableException } = require('@nestjs/common');
const { SgdmAccessService } = require('../dist/sgdm/sgdm-access.service');
const { sgdmIntegrationGet, sgdmIntegrationEnabled, SgdmNotFound, SgdmUnavailable } = require('../dist/sgdm/sgdm-integration');

const TENANT = '00000000-0000-0000-0000-000000000001';
const USER = '00000000-0000-0000-0000-000000000002';
const envKeys = ['SGDM_API_URL', 'SGDM_INTEGRATION_KEY', 'SGDM_ACCESS_CACHE_SECONDS', 'SGDM_INTERNAL_HOSTS', 'NODE_ENV'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
test.afterEach(() => envKeys.forEach(key => savedEnv[key] === undefined ? delete process.env[key] : process.env[key] = savedEnv[key]));

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
const NOT_CONFIRMED = 'Não foi possível confirmar os modelos liberados para você. Tente novamente em instantes.';
const NOT_ALLOWED = 'Este modelo não está liberado para você. Escolha outro no seletor do chat.';

test('devolve os slugs do SGDM e repete do cache sem nova chamada dentro do TTL', async t => {
  const calls = await sgdm(t, () => [200, { modelos: ['openai/gpt-5.5', 'anthropic/claude-sonnet-5'], padrao: 'openai/gpt-5.5' }]);
  const service = new SgdmAccessService();
  const expected = { slugs: ['openai/gpt-5.5', 'anthropic/claude-sonnet-5'], defaultSlug: 'openai/gpt-5.5' };
  assert.deepEqual(await service.allowed(TENANT, USER), expected);
  assert.deepEqual(await service.allowed(TENANT, USER), expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/v1/integracoes/i7ai/acesso/${TENANT}?usuarioId=${USER}`);
  assert.equal(calls[0].auth, 'Bearer integration-secret');
  // The tenant-wide list (automations) is a different cache entry, without usuarioId.
  await service.allowed(TENANT);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `/api/v1/integracoes/i7ai/acesso/${TENANT}`);
});

test('stale: TTL vencido e SGDM 500 devolve o valor antigo', async t => {
  let reply = [200, { modelos: ['openai/gpt-5.5'], padrao: null }];
  const calls = await sgdm(t, () => reply);
  process.env.SGDM_ACCESS_CACHE_SECONDS = '0';
  const service = new SgdmAccessService();
  service.logger = { warn: () => {}, error: () => {} };
  assert.deepEqual(await service.allowed(TENANT, USER), { slugs: ['openai/gpt-5.5'], defaultSlug: null });
  reply = [500, { message: 'boom' }];
  assert.deepEqual(await service.allowed(TENANT, USER), { slugs: ['openai/gpt-5.5'], defaultSlug: null });
  assert.equal(calls.length, 2);
});

test('nunca lido: SGDM fora devolve ServiceUnavailableException com a mensagem exata', async t => {
  await sgdm(t, () => [500, { message: 'boom' }]);
  const service = new SgdmAccessService();
  service.logger = { warn: () => {}, error: () => {} };
  await assert.rejects(service.allowed(TENANT, USER), error => error instanceof ServiceUnavailableException && error.message === NOT_CONFIRMED);
  // Malformed answers are not trusted either.
  const other = await sgdm(t, () => [200, { modelos: 'tudo' }]);
  await assert.rejects(new SgdmAccessService().allowed(TENANT, USER), error => error instanceof ServiceUnavailableException && error.message === NOT_CONFIRMED);
  assert.equal(other.length, 1);
});

test('SGDM 404 (usuário ou prefeitura desconhecidos) fecha o acesso, sem liberar tudo', async t => {
  await sgdm(t, () => [404, { message: 'não encontrado' }]);
  assert.deepEqual(await new SgdmAccessService().allowed(TENANT, USER), { slugs: [], defaultSlug: null });
});

test('integração desligada devolve null (sem filtro) e não chama o SGDM', async () => {
  delete process.env.SGDM_API_URL; delete process.env.SGDM_INTEGRATION_KEY;
  const service = new SgdmAccessService();
  assert.equal(await service.allowed(TENANT, USER), null);
  await service.assertAllowed(TENANT, USER, 'qualquer/modelo');
  assert.equal(sgdmIntegrationEnabled({ SGDM_API_URL: 'http://x', SGDM_INTEGRATION_KEY: ' ' }), false);
  assert.equal(sgdmIntegrationEnabled({ SGDM_API_URL: 'http://x', SGDM_INTEGRATION_KEY: 'k' }), true);
});

test('assertAllowed com slug fora da lista lança ForbiddenException com a mensagem exata', async t => {
  await sgdm(t, () => [200, { modelos: ['openai/gpt-5.5'], padrao: 'openai/gpt-5.5' }]);
  const service = new SgdmAccessService();
  await service.assertAllowed(TENANT, USER, 'openai/gpt-5.5');
  await assert.rejects(service.assertAllowed(TENANT, USER, 'anthropic/claude-opus-5'), error => error instanceof ForbiddenException && error.message === NOT_ALLOWED);
});

test('sgdmIntegrationGet: 404 vira SgdmNotFound, outros erros SgdmUnavailable sem a chave', async t => {
  let reply = [404, {}];
  await sgdm(t, () => reply);
  await assert.rejects(sgdmIntegrationGet('/integracoes/i7ai/modelos'), SgdmNotFound);
  reply = [401, { message: 'integration-secret' }];
  await assert.rejects(sgdmIntegrationGet('/integracoes/i7ai/modelos'), error => error instanceof SgdmUnavailable && !error.message.includes('integration-secret'));
  reply = [200, { modelos: [] }];
  assert.deepEqual(await sgdmIntegrationGet('/integracoes/i7ai/modelos'), { modelos: [] });
  await assert.rejects(sgdmIntegrationGet('/x', { ...process.env, NODE_ENV: 'production', SGDM_API_URL: 'http://public.example/api' }), SgdmUnavailable);
});
