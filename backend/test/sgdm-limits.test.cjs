const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('reflect-metadata');
const { SgdmLimitsService } = require('../dist/sgdm/sgdm-limits.service');

const TENANT = '00000000-0000-0000-0000-000000000001';
const USER = '00000000-0000-0000-0000-000000000002';
const envKeys = ['SGDM_API_URL', 'SGDM_INTEGRATION_KEY', 'SGDM_LIMITS_CACHE_SECONDS', 'NODE_ENV'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
test.afterEach(() => envKeys.forEach(key => savedEnv[key] === undefined ? delete process.env[key] : process.env[key] = savedEnv[key]));

// Fake SGDM implementing GET /integracoes/i7ai/limites/:tenantId?usuarioId= (Task 2 contract).
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
function quietLogger() {
  const warnings = [];
  return { warnings, logger: { warn: message => warnings.push(String(message)), error: message => warnings.push(String(message)), log: () => {} } };
}
const LIMITE = { orcamentoMensalUsd: 25.5, bloquear: true, chamadasPorMinuto: 10, tokensPorMinuto: null };
const EXPECTED = { monthlyBudgetUsd: 25.5, block: true, callsPerMinute: 10, tokensPerMinute: null };

test('devolve os limites do usuário e repete do cache dentro do TTL', async t => {
  const calls = await sgdm(t, () => [200, { usuario: LIMITE }]);
  const service = new SgdmLimitsService();
  assert.deepEqual(await service.forUser(TENANT, USER), EXPECTED);
  assert.deepEqual(await service.forUser(TENANT, USER), EXPECTED);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/v1/integracoes/i7ai/limites/${TENANT}?usuarioId=${USER}`);
  assert.equal(calls[0].auth, 'Bearer integration-secret');
});

test('usuario: null devolve null (sem limite próprio)', async t => {
  await sgdm(t, () => [200, { usuario: null }]);
  assert.equal(await new SgdmLimitsService().forUser(TENANT, USER), null);
});

test('stale: TTL vencido e SGDM 500 devolve o valor antigo com aviso', async t => {
  let reply = [200, { usuario: LIMITE }];
  const calls = await sgdm(t, () => reply);
  process.env.SGDM_LIMITS_CACHE_SECONDS = '0';
  const service = new SgdmLimitsService(); const { warnings, logger } = quietLogger(); service.logger = logger;
  assert.deepEqual(await service.forUser(TENANT, USER), EXPECTED);
  reply = [500, { message: 'boom' }];
  assert.deepEqual(await service.forUser(TENANT, USER), EXPECTED);
  assert.equal(calls.length, 2);
  assert.equal(warnings.length, 1);
  assert.ok(warnings.every(message => !message.includes('integration-secret')));
});

test('após TTL + 600 s com SGDM fora, segue sem limite do usuário (null)', async t => {
  let reply = [200, { usuario: LIMITE }];
  await sgdm(t, () => reply);
  process.env.SGDM_LIMITS_CACHE_SECONDS = '60';
  const service = new SgdmLimitsService(); service.logger = quietLogger().logger;
  const realNow = Date.now; t.after(() => { Date.now = realNow; });
  const start = realNow(); Date.now = () => start;
  await service.forUser(TENANT, USER);
  reply = [500, {}];
  Date.now = () => start + (60 + 600) * 1000 - 1;
  assert.deepEqual(await service.forUser(TENANT, USER), EXPECTED);
  Date.now = () => start + (60 + 600) * 1000 + 1;
  assert.equal(await service.forUser(TENANT, USER), null);
});

test('nunca lido com o SGDM fora: null e warn sem a chave; resposta malformada também', async t => {
  await sgdm(t, () => [500, { message: 'integration-secret' }]);
  const service = new SgdmLimitsService(); const { warnings, logger } = quietLogger(); service.logger = logger;
  assert.equal(await service.forUser(TENANT, USER), null);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('integration-secret'));
  await sgdm(t, () => [200, { usuario: { orcamentoMensalUsd: 'muito', bloquear: true, chamadasPorMinuto: null, tokensPorMinuto: null } }]);
  const other = new SgdmLimitsService(); const quiet = quietLogger(); other.logger = quiet.logger;
  assert.equal(await other.forUser(TENANT, USER), null);
  assert.equal(quiet.warnings.length, 1);
});

test('integração desligada devolve null sem chamar o SGDM', async t => {
  const calls = await sgdm(t, () => [200, { usuario: LIMITE }]);
  delete process.env.SGDM_API_URL; delete process.env.SGDM_INTEGRATION_KEY;
  assert.equal(await new SgdmLimitsService().forUser(TENANT, USER), null);
  assert.equal(calls.length, 0);
});
