const { quotaFixture } = require('./helpers/quota-fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { AiGatewayService, calculateUsageCost } = require('../dist/ai/ai-gateway.service');

const selectedModel = { id: 'model-primary', slug: 'gpt-4o-mini', inputPrice: 0.15, outputPrice: 0.60, provider: { name: 'OpenAI', slug: 'openai', config: null } };
function fixture() {
  const records = { messages: [], usage: [], audit: [], conversationCreates: [], conversationUpdates: [], retrieval: [], toolLoads: [] };
  const agent = { id: 'agent-a', tenantId: 'tenant-a', status: 'ACTIVE', name: 'Analista', systemPrompt: 'Use evidências.', temperature: 0.35, maxTokens: 900, advancedReasoning: false, models: [{ isPrimary: false, model: { ...selectedModel, slug: 'wrong-model' } }, { isPrimary: true, model: { ...selectedModel } }] };
  const prisma = {
    agent: { findFirst: async ({ where }) => { assert.equal(where.tenantId, 'tenant-a'); return agent; } },
    license: { findFirst: async () => null },
    automation: { findFirst: async () => ({ id: 'automation-a' }) },
    conversation: {
      findFirst: async () => null,
      create: async ({ data }) => { records.conversationCreates.push(data); return { id: 'conversation-a' }; },
      update: async ({ data }) => { records.conversationUpdates.push(data); return {}; },
    },
    message: { create: async ({ data }) => { const message = { id: 'message-' + records.messages.length, createdAt: new Date(), ...data }; records.messages.push(message); return message; } },
    aiUsage: { create: async ({ data }) => { records.usage.push(data); return data; } },
    auditLog: { create: async ({ data }) => { records.audit.push(data); return data; } },
  };
  prisma.$transaction = async (callback) => callback(prisma);
  const rag = { searchForAgent: async (...args) => { records.retrieval.push(args); return [{ id: 'chunk-a', content: 'Orçamento aprovado.', documentId: 'document-a', knowledgeBaseId: 'base-a', documentName: 'Lei 10', chunkIndex: 0, retrieval: 'literal' }]; } };
  const agentTools = { load: async (...args) => { records.toolLoads.push(args); return []; } };
  return { service: new AiGatewayService(prisma, rag, agentTools, quotaFixture(prisma, records)), prisma, records, agent };
}

const originalFetch = global.fetch;
const envKeys = ['OPENAI_API_KEY', 'AI_GATEWAY_URL', 'AI_GATEWAY_API_KEY', 'OPENAI_BASE_URL', 'OMNIROUTER_BASE_URL', 'OMNIROUTER_API_KEY', 'NODE_ENV'];
const savedEnvironment = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
test.beforeEach(() => { envKeys.forEach((key) => delete process.env[key]); });
test.afterEach(() => { global.fetch = originalFetch; envKeys.forEach((key) => { if (savedEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = savedEnvironment[key]; }); });

function providerResponse(answer = 'A lei prevê orçamento. [Fonte 1]') {
  return new Response(JSON.stringify({ id: 'response-test', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer, annotations: [] }] }], usage: { input_tokens: 200, output_tokens: 50 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

for (const [status, message] of [['DRAFT', 'Ative o agente nas configurações para executar.'], ['ARCHIVED', 'Este agente está arquivado.']]) {
  for (const operation of ['chat', 'chatStream', 'executeAgent']) {
    test(`inactive agent ${status} is rejected by ${operation} before provider, retrieval, tools or writes`, async () => {
      const { service, agent, records } = fixture();
      agent.status = status;
      process.env.AI_GATEWAY_URL = 'https://gateway.invalid';
      let providerCalls = 0;
      const events = [];
      global.fetch = async () => {
        providerCalls++;
        return new Response(JSON.stringify({ answer: 'Não deveria ser executado', usage: { inputTokens: 10, outputTokens: 5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const execute = () => operation === 'executeAgent'
        ? service.executeAgent('agent-a', 'tenant-a', { message: 'Resuma', automationId: 'automation-a' })
        : operation === 'chatStream'
          ? service.chatStream('agent-a', 'tenant-a', { message: 'Resuma' }, 'user-a', (...event) => events.push(event))
          : service.chat('agent-a', 'tenant-a', { message: 'Resuma' }, 'user-a');

      await assert.rejects(execute, (error) => error.getStatus?.() === 400 && error.message === message);
      assert.equal(providerCalls, 0);
      assert.deepEqual(events, []);
      assert.deepEqual(records, { messages: [], usage: [], audit: [], conversationCreates: [], conversationUpdates: [], retrieval: [], toolLoads: [], reservations: [] });
    });
  }
}

test('chat uses primary model/settings, parses real Responses output and persists history, usage and audit', async () => {
  const { service, records } = fixture(); let request;
  process.env.OPENAI_API_KEY = 'test-key-never-sent';
  global.fetch = async (_url, options) => { request = JSON.parse(options.body); return providerResponse(); };
  const result = await service.chat('agent-a', 'tenant-a', { message: 'Qual o orçamento?' }, 'user-a');
  assert.equal(result.answer, 'A lei prevê orçamento. [Fonte 1]'); assert.equal(result.conversationId, 'conversation-a');
  assert.equal(request.model, selectedModel.slug); assert.equal(request.temperature, 0.35); assert.equal(request.max_output_tokens, 900); assert.equal(request.store, false);
  assert.match(request.instructions, /Fonte 1/); assert.equal(request.input.at(-1).content, 'Qual o orçamento?');
  assert.deepEqual(records.retrieval[0].slice(0, 2), ['tenant-a', 'agent-a']);
  assert.equal(records.messages.length, 2); assert.equal(records.messages[0].role, 'user'); assert.equal(records.messages[1].role, 'assistant');
  assert.ok(records.messages[1].createdAt > records.messages[0].createdAt);
  assert.equal(records.usage[0].modelId, 'model-primary'); assert.equal(records.usage[0].userId, 'user-a'); assert.equal(records.usage[0].inputTokens, 200);
  assert.equal(result.usage.cost, 0.00006); assert.equal(result.usage.costConfigured, true); assert.equal(records.audit[0].metadata.conversationId, 'conversation-a');
});

test('cross-user or cross-agent conversation is rejected before provider/retrieval', async () => {
  const { service, prisma, records } = fixture(); let calls = 0;
  prisma.conversation.findFirst = async ({ where }) => { assert.deepEqual(where, { id: 'foreign', tenantId: 'tenant-a', userId: 'user-a', agentId: 'agent-a' }); return null; };
  global.fetch = async () => { calls++; throw Error('Forbidden network'); };
  await assert.rejects(() => service.chat('agent-a', 'tenant-a', { message: 'hello', conversationId: 'foreign' }, 'user-a'), /Conversa não encontrada/);
  assert.equal(calls, 0); assert.equal(records.retrieval.length, 0); assert.equal(records.messages.length, 0);
});

test('existing conversation history is supplied to provider without creating another conversation', async () => {
  const { service, prisma, records } = fixture(); let request;
  process.env.OPENAI_API_KEY = 'test-key-never-sent';
  prisma.conversation.findFirst = async () => ({ id: 'owned', messages: [{ role: 'assistant', content: 'Resposta anterior' }, { role: 'user', content: 'Pergunta anterior' }] });
  global.fetch = async (_url, options) => { request = JSON.parse(options.body); return providerResponse(); };
  const result = await service.chat('agent-a', 'tenant-a', { message: 'Continue', conversationId: 'owned' }, 'user-a');
  assert.equal(result.conversationId, 'owned'); assert.equal(records.conversationCreates.length, 0);
  assert.deepEqual(request.input.map((item) => item.content), ['Pergunta anterior', 'Resposta anterior', 'Continue']);
});

test('missing provider or non-success response fails clearly without fabricated answer or messages', async () => {
  const { service, records } = fixture();
  await assert.rejects(() => service.chat('agent-a', 'tenant-a', { message: 'hello' }, 'user-a'), /não está configurado/);
  assert.equal(records.retrieval.length, 0);
  process.env.OPENAI_API_KEY = 'test-key-never-sent';
  global.fetch = async () => new Response(JSON.stringify({ error: { message: 'credential-body-must-not-leak' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(() => service.chat('agent-a', 'tenant-a', { message: 'hello' }, 'user-a'), /credencial/);
  assert.equal(records.messages.length, 0); assert.equal(records.usage.length, 0);
});

test('automation execution records usage with no user or conversation requirement', async () => {
  const { service, records } = fixture();
  process.env.AI_GATEWAY_URL = 'https://gateway.invalid';
  global.fetch = async () => new Response(JSON.stringify({ answer: 'Executado', usage: { inputTokens: 10, outputTokens: 5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const result = await service.executeAgent('agent-a', 'tenant-a', { message: 'Resuma', automationId: 'automation-a' });
  assert.equal(result.answer, 'Executado'); assert.equal(records.conversationCreates.length, 0); assert.equal(records.messages.length, 0);
  assert.equal(records.usage[0].userId, undefined); assert.equal(records.usage[0].automationId, 'automation-a'); assert.equal(records.audit[0].event, 'agent.automation_executed');
});

test('missing price or gateway token counters marks cost as unconfigured', async () => {
  const { service, agent } = fixture(); agent.models[1].model.inputPrice = null;
  process.env.AI_GATEWAY_URL = 'https://gateway.invalid';
  global.fetch = async () => new Response(JSON.stringify({ answer: 'Executado' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const result = await service.executeAgent('agent-a', 'tenant-a', { message: 'Resuma' });
  assert.equal(result.usage.measured, false); assert.equal(result.usage.costConfigured, false);
  assert.equal(calculateUsageCost(1_000_000, 2_000_000, 0.15, 0.60), 1.35);
});

test('token quota prevents provider requests once the active license allowance is consumed', async () => {
  const { service, prisma, records } = fixture(); let calls = 0;
  process.env.OPENAI_API_KEY = 'test-key-never-sent';
  prisma.license.findFirst = async () => ({ status: 'ACTIVE', startDate: new Date(), endDate: null, maxTokens: 100n });
  prisma.aiUsage.aggregate = async () => ({ _sum: { inputTokens: 80, outputTokens: 20 } });
  global.fetch = async () => { calls++; throw Error('Must not call provider'); };
  await assert.rejects(() => service.executeAgent('agent-a', 'tenant-a', { message: 'hello' }), /limite de tokens/);
  assert.equal(calls, 0); assert.equal(records.retrieval.length, 0);
});

test('internal automation permits larger composed context while normal chat remains bounded', async () => {
  const { service } = fixture(); process.env.AI_GATEWAY_URL = 'https://gateway.invalid';
  global.fetch = async () => new Response(JSON.stringify({ answer: 'Contexto processado', usage: { inputTokens: 200, outputTokens: 5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  assert.equal((await service.executeAgent('agent-a', 'tenant-a', { message: 'a'.repeat(20000), automationId: 'automation-a' })).answer, 'Contexto processado');
  await assert.rejects(() => service.chat('agent-a', 'tenant-a', { message: 'a'.repeat(20000) }, 'user-a'), /16000/);
  await assert.rejects(() => service.executeAgent('agent-a', 'tenant-a', { message: 'a'.repeat(200001), automationId: 'automation-a' }), /200000/);
});

test('production chat denies missing and expired latest licenses without contacting provider', async () => {
  const { service, prisma, records } = fixture(); let calls = 0;
  process.env.NODE_ENV = 'production'; process.env.OPENAI_API_KEY = 'test-key-never-sent';
  global.fetch = async () => { calls++; throw Error('Must not call provider'); };
  await assert.rejects(() => service.executeAgent('agent-a', 'tenant-a', { message: 'hello' }), /licença/i);
  prisma.license.findFirst = async ({ where }) => {
    assert.deepEqual(where, { tenantId: 'tenant-a' });
    return { status: 'ACTIVE', startDate: new Date(Date.now() - 86400000), endDate: new Date(Date.now() - 1000), maxTokens: 10000n };
  };
  await assert.rejects(() => service.executeAgent('agent-a', 'tenant-a', { message: 'hello' }), /expirada/i);
  assert.equal(calls, 0); assert.equal(records.retrieval.length, 0); assert.equal(records.usage.length, 0);
});

test('monthly quota counts from later of UTC month start and license start', async () => {
  const { service, prisma } = fixture(); const captured = [];
  process.env.AI_GATEWAY_URL = 'https://gateway.invalid';
  const now = new Date(); const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const earlier = new Date(monthStart.getTime() - 86400000);
  prisma.license.findFirst = async () => ({ status: 'ACTIVE', startDate: earlier, endDate: null, maxTokens: 10000n });
  prisma.aiUsage.aggregate = async ({ where }) => { captured.push(where.createdAt.gte); return { _sum: { inputTokens: 0, outputTokens: 0 } }; };
  global.fetch = async () => new Response(JSON.stringify({ answer: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  await service.executeAgent('agent-a', 'tenant-a', { message: 'hello' });
  assert.equal(captured[0].toISOString(), monthStart.toISOString());
  const later = new Date(Math.min(now.getTime() - 1, monthStart.getTime() + 1000));
  prisma.license.findFirst = async () => ({ status: 'ACTIVE', startDate: later, endDate: null, maxTokens: 10000n });
  await service.executeAgent('agent-a', 'tenant-a', { message: 'hello' });
  assert.equal(captured.at(-1).toISOString(), later.toISOString());
});

test('OmniRouter path: cached tokens fall back to the input price and the response cost is the recorded cost', async () => {
  const { service, prisma, records } = fixture();
  const { usageCost } = require('../dist/ai/ai-quota.service');
  let scope;
  const omni = { generate: async input => {
    scope = input.quotaScope;
    const usage = { inputTokens: 100, outputTokens: 10, measured: true, cachedInputTokens: 60 };
    return { answer: 'ok', inputTokens: 100, outputTokens: 10, measured: true, cost: usageCost(scope, usage).cost, toolCalls: [] };
  } };
  const gateway = new (require('../dist/ai/ai-gateway.service').AiGatewayService)(prisma, service.rag, service.agentTools, service.quota, undefined, omni);
  process.env.OMNIROUTER_BASE_URL = 'http://127.0.0.1:1/v1/';
  try {
    const result = await gateway.chat('agent-a', 'tenant-a', { message: 'Qual o orçamento?' }, 'user-a');
    assert.equal(scope.cachedInputPrice, 0.15);
    // No cache-write price in the catalog: written tokens fall back to the input price.
    assert.equal(scope.cacheWriteInputPrice, 0.15);
    assert.equal(scope.kind, 'resposta');
    assert.equal(result.usage.cost, calculateUsageCost(100, 10, 0.15, 0.60, 60, 0.15));
  } finally { delete process.env.OMNIROUTER_BASE_URL; }
});
