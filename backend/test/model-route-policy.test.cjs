const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { isAllowedRoute, allowedRoutePrefixes, routePolicyMessage } = require('../dist/catalog/model-route-policy');
const { OmniRouterService } = require('../dist/ai/omnirouter.service');
const { ChatCatalogController } = require('../dist/ai/chat-catalog.controller');

test('somente rotas de chave de API com termos comerciais são liberadas', () => {
  for (const slug of ['openai/gpt-5.5', 'anthropic/claude-sonnet-4-6', 'gemini/gemini-3-pro', 'xai/grok-4', 'OpenAI/gpt-4o']) assert.equal(isAllowedRoute(slug, {}), true, slug);
  for (const slug of ['antigravity/claude-sonnet-4-6', 'cx/gpt-5.6-luna-low', 'auto/best-chat', 'no-think/openai/gpt-4o', 'deepseek/deepseek-v4-pro', 'Free', 'codar', '/gpt', '', null]) assert.equal(isAllowedRoute(slug, {}), false, String(slug));
});

test('prefixos podem ser ajustados pelo ambiente', () => {
  const env = { OMNIROUTER_ALLOWED_PREFIXES: ' openai , xai ' };
  assert.deepEqual(allowedRoutePrefixes(env), ['openai', 'xai']);
  assert.equal(isAllowedRoute('anthropic/claude', env), false);
  assert.equal(isAllowedRoute('xai/grok-4', env), true);
  assert.deepEqual(allowedRoutePrefixes({ OMNIROUTER_ALLOWED_PREFIXES: ' , ' }), ['openai', 'anthropic', 'gemini', 'xai']);
  assert.match(routePolicyMessage('cx/gpt', env), /cx\/gpt.*openai, xai/);
});

test('OmniRouter recusa rota proibida antes de reservar cota ou chamar a rede', async t => {
  const previous = { base: process.env.OMNIROUTER_BASE_URL, key: process.env.OMNIROUTER_API_KEY };
  process.env.OMNIROUTER_BASE_URL = 'https://gateway.example/v1';
  process.env.OMNIROUTER_API_KEY = 'test-key';
  t.after(() => { process.env.OMNIROUTER_BASE_URL = previous.base; process.env.OMNIROUTER_API_KEY = previous.key; });
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => { calls++; throw new Error('network must not be used'); };
  t.after(() => { global.fetch = originalFetch; });
  const quota = { reserve: async () => { calls++; }, release: async () => {}, record: async () => {} };
  const service = new OmniRouterService({ definitions: async () => [] }, quota);
  await assert.rejects(service.generate({ agent: { id: 'a', maxTokens: 100, advancedReasoning: false }, model: { slug: 'antigravity/claude-sonnet-4-6', capabilities: null, provider: { config: null } }, instructions: 'x', message: 'oi', history: [], functions: [], userId: 'u' }), /não usa uma rota liberada/);
  assert.equal(calls, 0);
});

test('catálogo do chat oculta modelos de rotas proibidas quando o gateway está ativo', async t => {
  const previous = process.env.OMNIROUTER_BASE_URL;
  t.after(() => { process.env.OMNIROUTER_BASE_URL = previous; });
  const models = [{ id: '1', slug: 'openai/gpt-5.5' }, { id: '2', slug: 'antigravity/claude-sonnet-4-6' }, { id: '3', slug: 'cx/gpt-5.6-luna-low' }];
  const controller = new ChatCatalogController({ list: async () => [{ id: 'agent', status: 'ACTIVE' }] }, { activeModels: async () => models });
  const request = { user: { tenantId: 't', sub: 'u' } };
  process.env.OMNIROUTER_BASE_URL = 'https://gateway.example/v1';
  assert.deepEqual((await controller.list(request)).models.map(model => model.id), ['1']);
  delete process.env.OMNIROUTER_BASE_URL;
  assert.equal((await controller.list(request)).models.length, 3, 'adaptadores diretos sem gateway mantêm o catálogo');
});

test('base do gateway: HTTPS, localhost no desenvolvimento e serviços Docker internos declarados', () => {
  const { gatewayBaseAllowed } = require('../dist/catalog/model-route-policy');
  const url = value => new URL(value);
  assert.equal(gatewayBaseAllowed(url('https://gateway.example.com/v1'), { NODE_ENV: 'production' }), true);
  assert.equal(gatewayBaseAllowed(url('http://localhost:4000/v1'), { NODE_ENV: 'development' }), true);
  assert.equal(gatewayBaseAllowed(url('http://localhost:4000/v1'), { NODE_ENV: 'production' }), false);
  assert.equal(gatewayBaseAllowed(url('http://litellm:4000/v1'), { NODE_ENV: 'production' }), false);
  const internal = { NODE_ENV: 'production', OMNIROUTER_INTERNAL_HOSTS: ' LiteLLM , other ' };
  assert.equal(gatewayBaseAllowed(url('http://litellm:4000/v1'), internal), true);
  // Only single-label Docker service names; public or dotted hosts stay HTTPS-only.
  assert.equal(gatewayBaseAllowed(url('http://litellm.example.com/v1'), { NODE_ENV: 'production', OMNIROUTER_INTERNAL_HOSTS: 'litellm.example.com' }), false);
  assert.equal(gatewayBaseAllowed(url('http://public.example/v1'), internal), false);
  for (const value of ['http://user:pw@litellm:4000/v1', 'http://litellm:4000/v1?key=x', 'http://litellm:4000/v1#k', 'file:///tmp/x']) assert.equal(gatewayBaseAllowed(url(value), internal), false, value);
});
