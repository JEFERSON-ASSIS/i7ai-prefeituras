const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { ConversationSummaryService } = require('../dist/ai/conversation-summary.service');
const { OmniRouterService } = require('../dist/ai/omnirouter.service');
const { OPTIMIZATION_DEFAULTS } = require('../dist/sgdm/optimization-defaults');
const { quotaFixture } = require('./helpers/quota-fixture.cjs');

const envKeys = ['OMNIROUTER_BASE_URL', 'OMNIROUTER_API_KEY', 'NODE_ENV'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const originalFetch = global.fetch;
test.beforeEach(() => { process.env.NODE_ENV = 'test'; process.env.OMNIROUTER_BASE_URL = 'https://omni.invalid/v1'; process.env.OMNIROUTER_API_KEY = 'synthetic-fixture'; });
test.afterEach(() => { global.fetch = originalFetch; envKeys.forEach(key => { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }); });

const SOURCE_TEXT = 'Conforme art. 75 da Lei nº 14.133/2021, dispensa até R$ 59.906,02 em 15/03/2026 no processo 2026.0001234-5 da Secretaria de Obras.';
const FULL = 'O usuário perguntou sobre dispensa. Art. 75 da Lei nº 14.133/2021, até R$ 59.906,02, em 15/03/2026, processo 2026.0001234-5.';
const NO_DATE = 'O usuário perguntou sobre dispensa. Art. 75 da Lei nº 14.133/2021, até R$ 59.906,02, processo 2026.0001234-5.';

function messages(count) {
  return Array.from({ length: count }, (_, index) => ({ id: 'm' + (index + 1), role: index % 2 ? 'assistant' : 'user', content: index === 0 ? SOURCE_TEXT : 'Mensagem ' + (index + 1), createdAt: new Date(1_000 + index) }));
}
const catalog = [
  { id: 'sonnet', slug: 'anthropic/claude-sonnet-5-5', active: true, inputPrice: 3, outputPrice: 15, capabilities: {}, provider: { slug: 'anthropic', config: null } },
  { id: 'haiku', slug: 'anthropic/claude-haiku-5-5', active: true, inputPrice: 1, outputPrice: 5, capabilities: {}, provider: { slug: 'anthropic', config: null } },
  { id: 'mini', slug: 'openai/gpt-4o-mini', active: true, inputPrice: 0.15, outputPrice: 0.6, capabilities: {}, provider: { slug: 'openai', config: null } },
];

function fixture({ count = 22, summary = null, through = null, disabled = false, ligado = true, modelos, allowed = null, answers = [FULL] } = {}) {
  const records = { usage: [], audit: [], updates: [], requests: [] };
  const conversation = { id: 'conv-a', tenantId: 'tenant-a', userId: 'user-a', agentId: 'agent-a', summary, summaryThroughMessageId: through, summaryDisabled: disabled, summaryModelId: null, summaryUpdatedAt: null, model: { slug: 'anthropic/claude-sonnet-5-5' } };
  const prisma = {
    license: { findFirst: async () => null },
    conversation: {
      findFirst: async ({ where }) => (where.id === conversation.id && where.tenantId === conversation.tenantId ? { ...conversation } : null),
      updateMany: async ({ where, data }) => {
        if (where.summaryDisabled !== conversation.summaryDisabled || where.summaryThroughMessageId !== conversation.summaryThroughMessageId) return { count: 0 };
        records.updates.push(data); Object.assign(conversation, data); return { count: 1 };
      },
    },
    agent: { findFirst: async () => ({ id: 'agent-a', status: 'ACTIVE' }) },
    message: { findMany: async () => messages(count) },
    aiModel: { findMany: async ({ where }) => catalog.filter(row => where.slug.in.includes(row.slug)) },
    aiUsage: { create: async ({ data }) => { records.usage.push(data); return data; } },
    auditLog: { create: async ({ data }) => { records.audit.push(data); return data; } },
  };
  prisma.$transaction = async callback => callback(prisma);
  const quota = quotaFixture(prisma, records);
  const omni = new OmniRouterService({ execute: async () => { throw new Error('sem ferramentas'); } }, quota);
  const cfg = JSON.parse(JSON.stringify(OPTIMIZATION_DEFAULTS));
  cfg.resumoHistorico.ligado = ligado; cfg.resumoHistorico.mensagens = 20;
  if (modelos) cfg.resumoHistorico.modelos = modelos;
  const optimization = { effective: async () => cfg };
  const access = { allowed: async () => (allowed ? { slugs: allowed, defaultSlug: null } : null) };
  const queue = [...answers];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); records.requests.push(body);
    const content = queue.length > 1 ? queue.shift() : queue[0];
    return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 400, completion_tokens: 60 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const service = new ConversationSummaryService(prisma, quota, omni, optimization, access);
  return { service, records, conversation };
}

test('resumo com todos os itens jurídicos: criado, campos gravados, auditoria só com contagens', async () => {
  const { service, records, conversation } = fixture();
  assert.equal(await service.summarize('tenant-a', 'conv-a'), 'criado');
  assert.equal(records.requests.length, 1);
  assert.equal(conversation.summary, FULL);
  assert.equal(conversation.summaryThroughMessageId, 'm12');
  assert.equal(conversation.summaryModelId, 'haiku');
  assert.ok(conversation.summaryUpdatedAt instanceof Date);
  const body = records.requests[0];
  assert.equal(body.model, 'anthropic/claude-haiku-5-5');
  assert.equal(body.max_tokens, 1500);
  assert.equal(body.messages[0].role, 'system'); assert.equal(typeof body.messages[0].content, 'string');
  assert.ok(!JSON.stringify(body).includes('cache_control'));
  // Only the 12 oldest messages (role + text) are summarized; the 10 most recent stay literal.
  const user = body.messages.at(-1).content;
  assert.match(user, /Mensagem 12\b/); assert.doesNotMatch(user, /Mensagem 13\b/);
  assert.equal(body.messages.length, 2);
  assert.deepEqual(records.audit.map(row => row.event), ['conversation.summary_created']);
  assert.deepEqual(records.audit[0].metadata, { messages: 12, model: 'anthropic/claude-haiku-5-5' });
});

test('resumo sem a data: nova tentativa com a lista de itens; ainda sem a data → rejeitado, campos intactos, auditoria sem texto', async () => {
  const { service, records, conversation } = fixture({ summary: null, answers: [NO_DATE, NO_DATE] });
  assert.equal(await service.summarize('tenant-a', 'conv-a'), 'rejeitado');
  assert.equal(records.requests.length, 2);
  const retry = records.requests[1].messages.at(-1).content;
  assert.match(retry, /Itens que precisam aparecer literalmente: .*15\/03\/2026/);
  assert.equal(conversation.summary, null); assert.equal(conversation.summaryThroughMessageId, null); assert.equal(records.updates.length, 0);
  assert.equal(records.audit.length, 1); assert.equal(records.audit[0].event, 'conversation.summary_rejected');
  assert.deepEqual(records.audit[0].metadata, { missing: 1, messages: 12 });
  const metadata = JSON.stringify(records.audit[0].metadata);
  for (const word of ['dispensa', 'Secretaria', '15/03/2026', 'Mensagem', 'Lei']) assert.ok(!metadata.includes(word), word);
  // Both paid calls were recorded like any call.
  assert.equal(records.usage.length, 2);
});

test('segunda tentativa completa: criado', async () => {
  const { service, records, conversation } = fixture({ answers: [NO_DATE, FULL] });
  assert.equal(await service.summarize('tenant-a', 'conv-a'), 'criado');
  assert.equal(records.requests.length, 2); assert.equal(conversation.summary, FULL);
});

test('modelo barato do mesmo provedor não liberado → usa o modelo da conversa', async () => {
  const { service, records, conversation } = fixture({ allowed: ['anthropic/claude-sonnet-5-5', 'openai/gpt-4o-mini'] });
  assert.equal(await service.summarize('tenant-a', 'conv-a'), 'criado');
  assert.equal(records.requests[0].model, 'anthropic/claude-sonnet-5-5');
  assert.equal(conversation.summaryModelId, 'sonnet');
});

test('modelos.anthropic null com openai disponível → nunca openai/*', async () => {
  const { service, records } = fixture({ modelos: { openai: 'openai/gpt-4o-mini', anthropic: null, gemini: null } });
  assert.equal(await service.summarize('tenant-a', 'conv-a'), 'criado');
  assert.ok(records.requests.every(body => body.model.startsWith('anthropic/')));
  assert.equal(records.requests[0].model, 'anthropic/claude-sonnet-5-5');
});

test('desligado, desligado pelo usuário ou sem lote → ignorado, sem chamada', async () => {
  for (const options of [{ ligado: false }, { disabled: true }, { count: 15 }, { count: 30, through: 'm12', summary: FULL }]) {
    const { service, records } = fixture(options);
    assert.equal(await service.summarize('tenant-a', 'conv-a'), 'ignorado', JSON.stringify(options));
    assert.equal(records.requests.length, 0); assert.equal(records.usage.length, 0); assert.equal(records.audit.length, 0);
  }
});

test('resumo seguinte incorpora o anterior e só as mensagens novas', async () => {
  const { service, records, conversation } = fixture({ count: 34, through: 'm12', summary: FULL });
  assert.equal(await service.summarize('tenant-a', 'conv-a'), 'criado');
  const user = records.requests[0].messages.at(-1).content;
  assert.ok(user.startsWith('Resumo anterior:\n' + FULL));
  assert.match(user, /Mensagem 13\b/); assert.match(user, /Mensagem 24\b/); assert.doesNotMatch(user, /Mensagem 25\b/); assert.doesNotMatch(user, /Mensagem 12\b/);
  assert.equal(conversation.summaryThroughMessageId, 'm24');
});

test('a chamada leva a tag origem:i7ai-resumo e ai_usage.kind resumo, com custo pela fórmula única', async () => {
  const { service, records } = fixture();
  await service.summarize('tenant-a', 'conv-a');
  const tags = records.requests[0].metadata.tags;
  assert.ok(tags.includes('origem:i7ai-resumo')); assert.ok(tags.includes('conversa:conv-a')); assert.ok(tags.includes('agente:agent-a'));
  assert.equal(records.requests[0].user, 'tenant-a');
  assert.equal(records.usage.length, 1);
  assert.equal(records.usage[0].kind, 'resumo'); assert.equal(records.usage[0].conversationId, 'conv-a'); assert.equal(records.usage[0].modelId, 'haiku');
  assert.equal(records.usage[0].cost, Number(((400 * 1 + 60 * 5) / 1_000_000).toFixed(6)));
  assert.equal(records.usage[0].status, 'COMPLETED');
});

test('enqueue sem fila nunca lança', async () => {
  const { service } = fixture();
  await service.enqueue('tenant-a', 'conv-a');
});
