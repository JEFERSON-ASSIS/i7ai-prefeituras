const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('reflect-metadata');
const { ResearchConfigService } = require('../dist/research/research-config.service');
const { OPTIMIZATION_DEFAULTS } = require('../dist/sgdm/optimization-defaults');

const envKeys = ['SGDM_API_URL', 'SGDM_INTEGRATION_KEY', 'SGDM_RESEARCH_CACHE_SECONDS', 'SGDM_FAILURE_CACHE_SECONDS', 'NODE_ENV'];
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
  process.env.SGDM_API_URL = 'http://127.0.0.1:' + server.address().port + '/api/v1';
  process.env.SGDM_INTEGRATION_KEY = 'integration-secret';
  return calls;
}

function service(warnings = []) {
  const instance = new ResearchConfigService();
  instance.logger = { warn: message => warnings.push(String(message)) };
  return instance;
}

test('pesquisa vem desligada por padrão', () => {
  assert.equal(OPTIMIZATION_DEFAULTS.pesquisaInternet.ligado, false);
});

test('traduz a resposta do SGDM e repete do cache dentro de 60 s', async t => {
  const calls = await sgdm(t, () => [200, { serperChave: 'k', custoPesquisaUsd: 0.002 }]);
  const config = service();
  assert.deepEqual(await config.get(), { serperKey: 'k', costPerSearchUsd: 0.002 });
  assert.deepEqual(await config.get(), { serperKey: 'k', costPerSearchUsd: 0.002 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/integracoes/i7ai/pesquisa');
  assert.equal(calls[0].auth, 'Bearer integration-secret');
});

test('chave ausente no SGDM vira null', async t => {
  await sgdm(t, () => [200, { serperChave: null, custoPesquisaUsd: 0.001 }]);
  assert.deepEqual(await service().get(), { serperKey: null, costPerSearchUsd: 0.001 });
});

test('SGDM 503 devolve sem chave e custo padrão, lembrando a falha sem nova chamada', async t => {
  const calls = await sgdm(t, () => [503, {}]);
  const warnings = [];
  const config = service(warnings);
  assert.deepEqual(await config.get(), { serperKey: null, costPerSearchUsd: 0.001 });
  assert.deepEqual(await config.get(), { serperKey: null, costPerSearchUsd: 0.001 });
  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 1);
});

test('resposta fora do contrato é tratada como indisponível e a chave não vai ao log', async t => {
  await sgdm(t, () => [200, { serperChave: 'segredo-123', custoPesquisaUsd: 'x' }]);
  const warnings = [];
  assert.deepEqual(await service(warnings).get(), { serperKey: null, costPerSearchUsd: 0.001 });
  assert.ok(!warnings.join(' ').includes('segredo-123'));
});

test('se o SGDM cair depois de uma resposta boa, serve a última resposta', async t => {
  let ok = true;
  const calls = await sgdm(t, () => ok ? [200, { serperChave: 'k', custoPesquisaUsd: 0.003 }] : [503, {}]);
  process.env.SGDM_RESEARCH_CACHE_SECONDS = '0';
  const config = service();
  assert.equal((await config.get()).serperKey, 'k');
  ok = false;
  assert.deepEqual(await config.get(), { serperKey: 'k', costPerSearchUsd: 0.003 });
  assert.equal(calls.length, 2);
});
