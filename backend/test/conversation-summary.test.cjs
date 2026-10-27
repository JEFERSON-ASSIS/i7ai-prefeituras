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

function fixture({ count = 22, summary = null, through = null, disabled = false, ligado = true, modelos, allowed = null, ownerAllowed, answers = [FULL], rejectedThrough = null, rejections = 0, contents } = {}) {
  const records = { usage: [], audit: [], updates: [], requests: [], allowedCalls: [] };
  const conversation = { id: 'conv-a', tenantId: 'tenant-a', userId: 'user-a', agentId: 'agent-a', summary, summaryThroughMessageId: through, summaryDisabled: disabled, summaryModelId: null, summaryUpdatedAt: null, summaryRejectedThroughMessageId: rejectedThrough, summaryRejections: rejections, model: { slug: 'anthropic/claude-sonnet-5-5' } };
  const prisma = {
    license: { findFirst: async () => null },
    conversation: {
      findFirst: async ({ where }) => (where.id === conversation.id && where.tenantId === conversation.tenantId ? { ...conversation } : null),
      updateMany: async ({ where, data }) => {
        if (where.summaryDisabled !== conversation.summaryDisabled || where.summaryThroughMessageId !== conversation.summaryThroughMessageId) return { count: 0 };
        records.updates.push(data);
        Object.assign(conversation, data, data.summaryRejections?.increment ? { summaryRejections: conversation.summaryRejections + data.summaryRejections.increment } : {});
        return { count: 1 };
      },
    },
    agent: { findFirst: async () => ({ id: 'agent-a', status: 'ACTIVE' }) },
    message: { findMany: async () => messages(count).map((item, index) => (contents?.[index] !== undefined ? { ...item, content: contents[index] } : item)) },
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
  const access = { allowed: async (_tenant, userId) => {
    records.allowedCalls.push(userId ?? null);
    const list = userId && ownerAllowed !== undefined ? ownerAllowed : allowed;
    if (list === 'falha') throw new Error('SGDM fora');
    return list ? { slugs: list, defaultSlug: null } : null;
  } };
  const queue = [...answers];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); records.requests.push(body);
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    // An answer is the summary text, { length: true } for a cut answer, or { status } for a gateway error.
    if (answer && typeof answer === 'object' && answer.status) return new Response('{"error":{"message":"falha"}}', { status: answer.status, headers: { 'Content-Type': 'application/json' } });
    const finish = answer && typeof answer === 'object' ? (answer.finish ?? (answer.length ? 'length' : 'stop')) : 'stop';
    const content = typeof answer === 'string' ? answer : 'Resumo cortado';
    return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }], usage: { prompt_tokens: 400, completion_tokens: 60 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
  assert.equal(conversation.summary, null); assert.equal(conversation.summaryThroughMessageId, null);
  // Only the rejection marker is written: the batch end and one more consecutive rejection.
  assert.deepEqual(records.updates, [{ summaryRejectedThroughMessageId: 'm12', summaryRejections: { increment: 1 } }]);
  assert.equal(conversation.summaryRejections, 1);
  assert.equal(records.audit.length, 1); assert.equal(records.audit[0].event, 'conversation.summary_rejected');
  assert.deepEqual(records.audit[0].metadata, { missing: 1, messages: 12, truncated: false, failed: false });
  const metadata = JSON.stringify(records.audit[0].metadata);
  for (const word of ['dispensa', 'Secretaria', '15/03/2026', 'Mensagem', 'Lei']) assert.ok(!metadata.includes(word), word);
  // Both paid calls were recorded like any call.
  assert.equal(records.usage.length, 2);
});

test('segunda tentativa completa: criado, e a marca de recusa anterior é zerada', async () => {
  const { service, records, conversation } = fixture({ answers: [NO_DATE, FULL], rejectedThrough: 'm2', rejections: 2 });
  assert.equal(await service.summarize('tenant-a', 'conv-a'), 'criado');
  assert.equal(records.requests.length, 2); assert.equal(conversation.summary, FULL);
  assert.equal(conversation.summaryRejections, 0); assert.equal(conversation.summaryRejectedThroughMessageId, null);
});

test('resposta cortada pelo limite de tokens = recusa (sem lançar, sem nova tentativa)', async () => {
  const { service, records, conversation } = fixture({ answers: [{ length: true }] });
  assert.equal(await service.summarize('tenant-a', 'conv-a'), 'rejeitado');
  assert.equal(records.requests.length, 1);
  assert.equal(conversation.summary, null); assert.equal(conversation.summaryRejections, 1);
  assert.deepEqual(records.audit[0].metadata, { missing: 0, messages: 12, truncated: true, failed: false });
  assert.equal(records.usage.length, 1); // the cut call is still paid and recorded
});

test('falhas que se repetiriam (filtro de conteúdo, finish inválido, resposta vazia, 4xx do gateway) = recusa, sem nova tentativa', async () => {
  for (const answer of [{ finish: 'content_filter' }, { finish: 'esquisito' }, '', { status: 400 }, { status: 404 }, { status: 422 }]) {
    const { service, records, conversation } = fixture({ answers: [answer, FULL] });
    assert.equal(await service.summarize('tenant-a', 'conv-a'), 'rejeitado', JSON.stringify(answer));
    assert.equal(records.requests.length, 1, JSON.stringify(answer));
    assert.equal(conversation.summary, null); assert.equal(conversation.summaryRejections, 1);
    assert.equal(conversation.summaryRejectedThroughMessageId, 'm12');
    assert.deepEqual(records.audit[0].metadata, { missing: 0, messages: 12, truncated: false, failed: true });
  }
});

test('falhas passageiras (5xx, 429, rede) lançam para o BullMQ tentar de novo e não contam como recusa', async () => {
  for (const answer of [{ status: 503 }, { status: 500 }, { status: 429 }]) {
    const { service, records, conversation } = fixture({ answers: [answer] });
    await assert.rejects(() => service.summarize('tenant-a', 'conv-a'), JSON.stringify(answer));
    assert.equal(records.requests.length, 1);
    assert.equal(conversation.summaryRejections, 0); assert.equal(records.audit.length, 0);
  }
  const { service, conversation } = fixture();
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(() => service.summarize('tenant-a', 'conv-a'));
  assert.equal(conversation.summaryRejections, 0);
});

test('um job nunca faz mais de 2 chamadas, contando as tentativas do BullMQ', async () => {
  // First attempt: the first call fails on the gateway (transient) and the job is retried.
  const { service, records } = fixture({ answers: [{ status: 503 }, NO_DATE, NO_DATE] });
  const saved = [];
  const budget = { used: 0, max: 2, record: async used => { saved.push(used); } };
  await assert.rejects(() => service.summarize('tenant-a', 'conv-a', budget));
  assert.equal(records.requests.length, 1);
  // Second attempt continues the same budget: one call left, so no legal-items retry → rejected.
  const retry = { used: saved.at(-1), max: 2, record: async used => { saved.push(used); } };
  assert.equal(await service.summarize('tenant-a', 'conv-a', retry), 'rejeitado');
  assert.equal(records.requests.length, 2);
  assert.deepEqual(saved, [1, 2]);
  // A spent budget makes no call at all.
  assert.equal(await service.summarize('tenant-a', 'conv-a', { used: 2, max: 2 }), 'ignorado');
  assert.equal(records.requests.length, 2);
});

test('depois de uma recusa só tenta de novo com N/2 mensagens novas; três recusas seguidas param o resumo', async () => {
  // 22 messages, rejected batch ended at m12: 10 after it (= N/2) → tries again.
  assert.equal(await fixture({ rejectedThrough: 'm12', rejections: 1 }).service.summarize('tenant-a', 'conv-a'), 'criado');
  // Rejected batch ended at m14: only 8 after it → waits, no call.
  const waiting = fixture({ rejectedThrough: 'm14', rejections: 1 });
  assert.equal(await waiting.service.summarize('tenant-a', 'conv-a'), 'ignorado');
  assert.equal(waiting.records.requests.length, 0);
  const stopped = fixture({ count: 60, rejectedThrough: 'm12', rejections: 3 });
  assert.equal(await stopped.service.summarize('tenant-a', 'conv-a'), 'ignorado');
  assert.equal(stopped.records.requests.length, 0);
});

test('conversa longa: um job lê no máximo um lote (4×N mensagens e 60.000 caracteres), das mais antigas', async () => {
  const many = fixture({ count: 200 });
  assert.equal(await many.service.summarize('tenant-a', 'conv-a'), 'criado');
  const user = many.records.requests[0].messages.at(-1).content;
  assert.match(user, /Mensagem 80\b/); assert.doesNotMatch(user, /Mensagem 81\b/);
  assert.equal(many.conversation.summaryThroughMessageId, 'm80');
  // Long messages: the character budget closes the batch first (but it always takes at least one message).
  const long = fixture({ count: 40, contents: Object.fromEntries(Array.from({ length: 39 }, (_, index) => [index + 1, 'x'.repeat(25_000)])) });
  assert.equal(await long.service.summarize('tenant-a', 'conv-a'), 'criado');
  assert.equal(long.conversation.summaryThroughMessageId, 'm3');
});

test('modelo da conversa fora da lista do dono → sem resumo; lista do dono indisponível → sem resumo', async () => {
  const modelos = { openai: 'openai/gpt-4o-mini', anthropic: null, gemini: null };
  const blocked = fixture({ modelos, ownerAllowed: ['openai/gpt-4o-mini'] });
  assert.equal(await blocked.service.summarize('tenant-a', 'conv-a'), 'ignorado');
  assert.equal(blocked.records.requests.length, 0);
  assert.ok(blocked.records.allowedCalls.includes('user-a'));
  const down = fixture({ modelos, ownerAllowed: 'falha' });
  assert.equal(await down.service.summarize('tenant-a', 'conv-a'), 'ignorado');
  const ok = fixture({ modelos, ownerAllowed: ['anthropic/claude-sonnet-5-5'] });
  assert.equal(await ok.service.summarize('tenant-a', 'conv-a'), 'criado');
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
