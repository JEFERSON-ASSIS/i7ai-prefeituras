const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('reflect-metadata');
const { ProviderCredentialsService } = require('../dist/ai/provider-credentials.service');

const SECRET = 'sk-proj-REALSECRETVALUE1234567890';
const envKeys = ['OMNIROUTER_BASE_URL', 'OMNIROUTER_API_KEY', 'LITELLM_ADMIN_URL', 'LITELLM_ADMIN_KEY', 'NODE_ENV'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
test.afterEach(() => envKeys.forEach(key => savedEnv[key] === undefined ? delete process.env[key] : process.env[key] = savedEnv[key]));

const superAdmin = { sub: 'user-1', tenantId: 'tenant-1', roles: ['SUPER_ADMIN'] };
const admin = { sub: 'user-2', tenantId: 'tenant-1', roles: ['ADMIN'] };

// Minimal LiteLLM admin API: /credentials CRUD plus /v1/chat/completions.
async function gateway(t, options = {}) {
  const store = new Map(Object.entries(options.initial || {}));
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const json = body ? JSON.parse(body) : undefined;
      calls.push({ method: request.method, url: request.url, auth: request.headers.authorization, body: json });
      const send = (status, payload) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)); };
      const name = decodeURIComponent((request.url.match(/^\/credentials(?:\/by_name)?\/([^/?]+)/) || [])[1] || '');
      if (request.method === 'GET' && request.url === '/credentials') return send(200, { success: true, credentials: [...store.entries()].map(([key, value]) => ({ credential_name: key, credential_info: { custom_llm_provider: key }, credential_values: { api_key: value.slice(0, 2) + '****' + value.slice(-2) }, source: 'db' })) });
      if (request.method === 'GET' && request.url.startsWith('/credentials/by_name/')) return store.has(name) ? send(200, { credential_name: name }) : send(404, { error: { message: 'Credential not found' } });
      if (request.method === 'POST' && request.url === '/credentials') { store.set(json.credential_name, json.credential_values.api_key); return send(200, { success: true }); }
      if (request.method === 'PATCH' && name) { store.set(name, json.credential_values.api_key); return send(200, { success: true }); }
      if (request.method === 'DELETE' && name) return store.delete(name) ? send(200, { success: true }) : send(404, { error: { message: 'Credential not found', code: '404' } });
      if (request.method === 'GET' && request.url === '/v1/models') return send(200, { data: [{ id: 'openai/gpt-4o-mini' }, { id: 'gemini/gemini-flash' }] });
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        if (options.chatError) return send(401, { error: { message: options.chatError } });
        return send(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      send(404, { error: { message: 'not found' } });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  process.env.NODE_ENV = 'test';
  process.env.OMNIROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.OMNIROUTER_API_KEY = 'sk-master';
  delete process.env.LITELLM_ADMIN_URL; delete process.env.LITELLM_ADMIN_KEY;
  return { store, calls };
}

function fixture() {
  const audits = [];
  const prisma = {
    auditLog: { create: async query => { audits.push(query.data); return {}; } },
  };
  return { service: new ProviderCredentialsService(prisma), audits };
}

test('only SUPER_ADMIN can list, save, remove or test provider keys, before contacting the gateway', async t => {
  const { calls } = await gateway(t);
  const { service } = fixture();
  await assert.rejects(service.list(admin), /SUPER_ADMIN/);
  await assert.rejects(service.save(admin, 'openai', SECRET), /SUPER_ADMIN/);
  await assert.rejects(service.remove(admin, 'openai'), /SUPER_ADMIN/);
  await assert.rejects(service.test(admin, 'openai'), /SUPER_ADMIN/);
  assert.equal(calls.length, 0);
});

test('list shows every supported provider with masked keys only', async t => {
  await gateway(t, { initial: { openai: SECRET } });
  const { service } = fixture();
  const list = await service.list(superAdmin);
  assert.deepEqual(list.map(item => item.provider), ['openai', 'anthropic', 'gemini']);
  assert.equal(list[0].configured, true);
  assert.equal(list[0].maskedKey, 'sk****90');
  assert.equal(list[1].configured, false);
  assert.ok(!JSON.stringify(list).includes(SECRET));
});

test('save creates a new credential, then updates it, with the admin key and no secret in audit or response', async t => {
  const { store, calls } = await gateway(t);
  const { service, audits } = fixture();
  const created = await service.save(superAdmin, 'openai', '  ' + SECRET + '  ');
  assert.equal(store.get('openai'), SECRET);
  assert.ok(calls.some(call => call.method === 'POST' && call.url === '/credentials' && call.body.credential_info.custom_llm_provider === 'openai'));
  await service.save(superAdmin, 'openai', SECRET + 'X');
  assert.equal(store.get('openai'), SECRET + 'X');
  assert.ok(calls.some(call => call.method === 'PATCH' && call.url === '/credentials/openai'));
  assert.ok(calls.every(call => call.auth === 'Bearer sk-master'));
  assert.deepEqual(audits.map(item => item.event), ['ai.credential.saved', 'ai.credential.saved']);
  assert.ok(!JSON.stringify(audits).includes(SECRET));
  assert.ok(!JSON.stringify(created).includes(SECRET));
});

test('save rejects unknown providers and malformed keys without contacting the gateway', async t => {
  const { calls } = await gateway(t);
  const { service } = fixture();
  await assert.rejects(service.save(superAdmin, 'antigravity', SECRET), /Provedor/);
  for (const key of ['', 'short', 'sk-with space inside-123456', 'sk-line\nbreak-1234567890', 'x'.repeat(600), 42]) await assert.rejects(service.save(superAdmin, 'openai', key), /chave/i);
  assert.equal(calls.length, 0);
});

test('remove deletes the credential and treats an absent one as already removed', async t => {
  const { store } = await gateway(t, { initial: { anthropic: SECRET } });
  const { service, audits } = fixture();
  await service.remove(superAdmin, 'anthropic');
  assert.equal(store.has('anthropic'), false);
  await service.remove(superAdmin, 'anthropic');
  assert.deepEqual(audits.map(item => item.event), ['ai.credential.removed', 'ai.credential.removed']);
});

test('test sends a tiny request with a gateway model of that provider and reports provider errors', async t => {
  const { calls } = await gateway(t, { initial: { openai: SECRET } });
  const { service } = fixture();
  assert.deepEqual(await service.test(superAdmin, 'openai'), { ok: true, model: 'openai/gpt-4o-mini', message: 'A chave respondeu corretamente.' });
  const chat = calls.find(call => call.url === '/v1/chat/completions');
  assert.equal(chat.body.model, 'openai/gpt-4o-mini');
  assert.ok(chat.body.max_tokens <= 16);
  await assert.rejects(service.test(superAdmin, 'anthropic'), /Nenhum modelo deste provedor/);
});

test('test returns the provider error message when the key is rejected', async t => {
  await gateway(t, { initial: { openai: SECRET }, chatError: 'AuthenticationError: Incorrect API key provided: sk-proj***7890.' });
  const { service } = fixture();
  const result = await service.test(superAdmin, 'openai');
  assert.equal(result.ok, false);
  assert.match(result.message, /Incorrect API key/);
});

test('gateway URL must pass the same policy as chat calls', async t => {
  await gateway(t);
  const { service } = fixture();
  process.env.NODE_ENV = 'production';
  await assert.rejects(service.list(superAdmin), /HTTPS/);
  process.env.NODE_ENV = 'test'; delete process.env.OMNIROUTER_BASE_URL;
  await assert.rejects(service.list(superAdmin), /gateway/i);
});
