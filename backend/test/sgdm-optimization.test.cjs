const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('reflect-metadata');
const { SgdmOptimizationService } = require('../dist/sgdm/sgdm-optimization.service');
const { OPTIMIZATION_DEFAULTS } = require('../dist/sgdm/optimization-defaults');

const TENANT = '00000000-0000-0000-0000-000000000001';
const AGENT = '00000000-0000-0000-0000-0000000000a1';
const OTHER_AGENT = '00000000-0000-0000-0000-0000000000a2';
const envKeys = ['SGDM_API_URL', 'SGDM_INTEGRATION_KEY', 'SGDM_OPTIMIZATION_CACHE_SECONDS', 'NODE_ENV'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
test.afterEach(() => envKeys.forEach(key => savedEnv[key] === undefined ? delete process.env[key] : process.env[key] = savedEnv[key]));

// Fake SGDM implementing GET /integracoes/i7ai/otimizacoes/:tenantId (Task 2 contract: { padrao, agentes }).
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
const clone = value => JSON.parse(JSON.stringify(value));
function body() {
  const padrao = clone(OPTIMIZATION_DEFAULTS); padrao.cachePrompt.ligado = false;
  const agente = clone(padrao); agente.imagensBaixa.ligado = false; agente.limiteSaida = { ligado: true, tokens: 1024 };
  return { padrao, agentes: { [AGENT]: agente } };
}

test('OPTIMIZATION_DEFAULTS é exatamente a tabela de padrões (mesmo literal do SGDM)', () => {
  assert.deepEqual(OPTIMIZATION_DEFAULTS, {
    modeloCaro: { ligado: true, fatorPreco: 4, saidaCurta: 500 },
    cachePrompt: { ligado: true },
    resumoHistorico: { ligado: false, mensagens: 20, modelos: { openai: 'openai/gpt-4o-mini', anthropic: 'anthropic/claude-haiku-5-5', gemini: null } },
    cacheExato: { ligado: true, ttlSegundos: 3600, chat: false },
    limiteSaida: { ligado: false, tokens: null },
    imagensBaixa: { ligado: true },
    sugestoes: { ligado: true, minimoUsd: 1 },
  });
});

test('devolve padrao e, para um agente com linha, agentes[id]; repete do cache dentro do TTL', async t => {
  const calls = await sgdm(t, () => [200, body()]);
  const service = new SgdmOptimizationService();
  assert.deepEqual(await service.effective(TENANT, OTHER_AGENT), body().padrao);
  assert.deepEqual(await service.effective(TENANT, AGENT), body().agentes[AGENT]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/v1/integracoes/i7ai/otimizacoes/${TENANT}`);
  assert.equal(calls[0].auth, 'Bearer integration-secret');
});

test('stale: TTL vencido e SGDM 500 devolve o valor antigo', async t => {
  let reply = [200, body()];
  const calls = await sgdm(t, () => reply);
  process.env.SGDM_OPTIMIZATION_CACHE_SECONDS = '0';
  const service = new SgdmOptimizationService(); const { warnings, logger } = quietLogger(); service.logger = logger;
  assert.deepEqual(await service.effective(TENANT, AGENT), body().agentes[AGENT]);
  reply = [500, { message: 'boom' }];
  assert.deepEqual(await service.effective(TENANT, AGENT), body().agentes[AGENT]);
  assert.equal(calls.length, 2);
  assert.equal(warnings.length, 1);
  assert.ok(warnings.every(message => !message.includes('integration-secret')));
});

test('após TTL + 600 s com SGDM fora, volta aos padrões', async t => {
  let reply = [200, body()];
  await sgdm(t, () => reply);
  process.env.SGDM_OPTIMIZATION_CACHE_SECONDS = '60';
  const service = new SgdmOptimizationService(); service.logger = quietLogger().logger;
  const realNow = Date.now; t.after(() => { Date.now = realNow; });
  const start = realNow(); Date.now = () => start;
  await service.effective(TENANT, AGENT);
  reply = [500, {}];
  Date.now = () => start + (60 + 600) * 1000 - 1;
  assert.deepEqual(await service.effective(TENANT, AGENT), body().agentes[AGENT]);
  Date.now = () => start + (60 + 600) * 1000 + 1;
  assert.deepEqual(await service.effective(TENANT, AGENT), OPTIMIZATION_DEFAULTS);
});

test('nunca lido com o SGDM fora: padrões sem lançar, warn sem a chave; resposta malformada também', async t => {
  await sgdm(t, () => [500, { message: 'integration-secret' }]);
  const service = new SgdmOptimizationService(); const { warnings, logger } = quietLogger(); service.logger = logger;
  assert.deepEqual(await service.effective(TENANT, AGENT), OPTIMIZATION_DEFAULTS);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('integration-secret'));
  await sgdm(t, () => [200, { padrao: { cachePrompt: 'sim' }, agentes: {} }]);
  const other = new SgdmOptimizationService(); const quiet = quietLogger(); other.logger = quiet.logger;
  assert.deepEqual(await other.effective(TENANT, AGENT), OPTIMIZATION_DEFAULTS);
  assert.equal(quiet.warnings.length, 1);
});

test('SGDM sem resposta (conexão recusada): padrões, sem lançar', async () => {
  process.env.NODE_ENV = 'test';
  process.env.SGDM_API_URL = 'http://127.0.0.1:1/api/v1';
  process.env.SGDM_INTEGRATION_KEY = 'integration-secret';
  const service = new SgdmOptimizationService(); service.logger = quietLogger().logger;
  assert.deepEqual(await service.effective(TENANT, AGENT), OPTIMIZATION_DEFAULTS);
});

test('integração desligada devolve os padrões sem chamar o SGDM', async t => {
  const calls = await sgdm(t, () => [200, body()]);
  delete process.env.SGDM_API_URL; delete process.env.SGDM_INTEGRATION_KEY;
  const service = new SgdmOptimizationService(); const { warnings, logger } = quietLogger(); service.logger = logger;
  assert.deepEqual(await service.effective(TENANT, AGENT), OPTIMIZATION_DEFAULTS);
  assert.equal(calls.length, 0);
  assert.equal(warnings.length, 0);
});

test('SGDM 404 (prefeitura desconhecida) é definitivo: padrões em cache, um aviso só', async t => {
  const calls = await sgdm(t, () => [404, { message: 'não encontrado' }]);
  const service = new SgdmOptimizationService(); const { warnings, logger } = quietLogger(); service.logger = logger;
  assert.deepEqual(await service.effective(TENANT, AGENT), OPTIMIZATION_DEFAULTS);
  assert.deepEqual(await service.effective(TENANT, AGENT), OPTIMIZATION_DEFAULTS);
  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 1);
});

test('o valor devolvido é uma cópia: alterar não contamina o cache nem os padrões', async t => {
  await sgdm(t, () => [200, body()]);
  const service = new SgdmOptimizationService();
  const first = await service.effective(TENANT, AGENT); first.imagensBaixa.ligado = true;
  assert.equal((await service.effective(TENANT, AGENT)).imagensBaixa.ligado, false);
  delete process.env.SGDM_API_URL;
  const defaults = await new SgdmOptimizationService().effective(TENANT, AGENT); defaults.cachePrompt.ligado = false;
  assert.equal(OPTIMIZATION_DEFAULTS.cachePrompt.ligado, true);
});
