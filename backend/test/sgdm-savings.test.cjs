const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { NotFoundException, UnauthorizedException, BadRequestException } = require('@nestjs/common');
const savings = require('../dist/sgdm/savings');
const { SgdmOptimizationController } = require('../dist/sgdm/sgdm-optimization.controller');
const { SgdmSavingsService, MODEL_NOT_RELEASED, MODEL_WITHOUT_TOOLS, MODEL_WITHOUT_REASONING, MODEL_CHANGED_SINCE, MODEL_WITHOUT_VISION, PREVIOUS_MODEL_NOT_RELEASED, NOTHING_TO_UNDO, UNDO_KIND } = require('../dist/sgdm/sgdm-savings.service');

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '11111111-1111-4111-8111-222222222222';
const AG = '22222222-2222-4222-8222-111111111111';
const M_OLD = '33333333-3333-4333-8333-111111111111';
const M_NEW = '33333333-3333-4333-8333-222222222222';
const M_OFF = '33333333-3333-4333-8333-333333333333';
const U1 = '44444444-4444-4444-8444-111111111111';
const saved = process.env.SGDM_INTEGRATION_KEY;
test.afterEach(() => saved === undefined ? delete process.env.SGDM_INTEGRATION_KEY : process.env.SGDM_INTEGRATION_KEY = saved);

const at = minutes => new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + minutes * 60_000);
function row(fields = {}) {
  return {
    tenantId: T1, agentId: AG, userId: U1, modelId: M_NEW, model: { slug: 'openai/gpt-4o-mini', inputPrice: 1, outputPrice: 2, cachedInputPrice: 0.1, cacheWriteInputPrice: 1.25 },
    inputTokens: 0, outputTokens: 0, cost: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, cacheHit: false, historySavedTokens: 0,
    lowDetailImages: 0, highDetailImages: 0, requestHash: null, kind: 'resposta', truncated: false, createdAt: at(0), ...fields,
  };
}

test('promptCacheSavings: read tokens save (input − cached), written tokens cost (write − input)', () => {
  assert.equal(savings.promptCacheSavings([row({ inputTokens: 1_100_000, cachedInputTokens: 1_000_000, cacheWriteInputTokens: 100_000 })]), 0.875);
  // A model without cache prices is billed at the input price: no invented savings.
  assert.equal(savings.promptCacheSavings([row({ cachedInputTokens: 1_000_000, model: { slug: 'x/y', inputPrice: 1, outputPrice: 2, cachedInputPrice: null, cacheWriteInputPrice: null } })]), 0);
});

test('exactCacheSavings: a hit is worth its cost at the model prices', () => {
  assert.equal(savings.exactCacheSavings([row({ cacheHit: true, inputTokens: 1000, outputTokens: 100 }), row({ inputTokens: 5000, outputTokens: 500 })]), 0.0012);
});

test('summarySavings: saved history tokens at input price minus the summaries cost', () => {
  const model = { slug: 'anthropic/claude', inputPrice: 3, outputPrice: 15 };
  assert.equal(savings.summarySavings([row({ model, historySavedTokens: 10_000 }), row({ model, kind: 'resumo', cost: '0.002' })]), 0.028);
});

test('imageSavings: only openai/ models, 680 tokens per image', () => {
  const openai = { slug: 'openai/gpt-4o-mini', inputPrice: 0.15, outputPrice: 0.6 };
  assert.deepEqual(savings.imageSavings([row({ model: openai, lowDetailImages: 2 })]), { real: 0.000204, estimate: 0 });
  assert.deepEqual(savings.imageSavings([row({ model: { ...openai, slug: 'anthropic/claude' }, lowDetailImages: 2, highDetailImages: 3 })]), { real: 0, estimate: 0 });
  assert.equal(savings.imageSavings([row({ model: openai, highDetailImages: 1 })]).estimate, 0.000102);
});

test('modelSwapSavings: only rows after the swap, with the new model, until the next swap; never negative per row', () => {
  const from = { slug: 'openai/gpt-4o', inputPrice: 2.5, outputPrice: 10 };
  const events = [{ agentId: AG, kind: 'TROCA_MODELO', createdAt: at(10), fromModelId: M_OLD, toModelId: M_NEW, from }];
  const tokens = { inputTokens: 1_000_000, outputTokens: 0 };
  // Before the swap: ignored. After: 2.5 − 1 = 1.5. Other model: ignored.
  const rows = [row({ ...tokens, createdAt: at(5) }), row({ ...tokens, createdAt: at(15) }), row({ ...tokens, createdAt: at(20), modelId: M_OLD })];
  assert.equal(savings.modelSwapSavings(rows, events), 1.5);
  // Undone at 30: rows after the undo are no longer counted for the first swap.
  const undo = { agentId: AG, kind: 'TROCA_MODELO', createdAt: at(30), fromModelId: M_NEW, toModelId: M_OLD, from: rows[0].model };
  assert.equal(savings.modelSwapSavings([...rows, row({ ...tokens, createdAt: at(40) })], [...events, undo]), 1.5);
  // A swap to a pricier model never yields a negative figure.
  assert.equal(savings.modelSwapSavings([row({ ...tokens, createdAt: at(15) })], [{ ...events[0], from: { slug: 'x', inputPrice: 0.1, outputPrice: 0 } }]), 0);
});

test('exactCacheEstimate: a repeat within the TTL counts, outside it does not', () => {
  const rows = [
    row({ requestHash: 'a', cost: 0.5, createdAt: at(0) }),
    row({ requestHash: 'a', cost: 0.5, createdAt: at(30) }),   // within 3600 s → counts
    row({ requestHash: 'a', cost: 0.5, createdAt: at(120) }),  // 120 min after the anchor → new anchor
    row({ requestHash: 'a', cost: 0.5, createdAt: at(121), tenantId: T2 }), // other prefeitura → its own anchor
    row({ requestHash: 'b', cost: 0.7, createdAt: at(1) }),
    row({ requestHash: null, cost: 9, createdAt: at(2) }),
  ];
  assert.equal(savings.exactCacheEstimate(rows, 3600), 0.5);
});

test('promptCacheEstimate: hits within 5 minutes; the write term only for anthropic/', () => {
  const anthropic = { slug: 'anthropic/claude', inputPrice: 3, outputPrice: 15, cachedInputPrice: 0.3, cacheWriteInputPrice: 3.75 };
  const rows = [row({ model: anthropic, createdAt: at(0) }), row({ model: anthropic, createdAt: at(2) }), row({ model: anthropic, createdAt: at(20) })];
  // 1 hit × 2000 × 2.7 − 2 misses × 2000 × 0.75 = 5400 − 3000 = 2400 → 0.0024
  assert.equal(savings.promptCacheEstimate(rows, { [AG]: 2000 }), 0.0024);
  assert.equal(savings.promptCacheEstimate(rows, { [AG]: 500 }), null);
  // OpenAI (and Gemini) cache the prefix by themselves, already in the measured figure: no Claude call, no estimate.
  assert.equal(savings.promptCacheEstimate(rows.map(item => ({ ...item, model: row().model })), { [AG]: 2000 }), null);
});

test('promptCacheEstimate: only anthropic/ rows count, mixed providers of one agent', () => {
  const anthropic = { slug: 'anthropic/claude', inputPrice: 3, outputPrice: 15, cachedInputPrice: 0.3, cacheWriteInputPrice: 3.75 };
  const openai = { slug: 'openai/gpt-4o', inputPrice: 2.5, outputPrice: 10, cachedInputPrice: 1.25, cacheWriteInputPrice: null };
  const gemini = { slug: 'gemini/gemini-2.5-pro', inputPrice: 1.25, outputPrice: 10, cachedInputPrice: 0.31, cacheWriteInputPrice: null };
  const rows = [
    row({ model: anthropic, createdAt: at(0) }),  // miss: 2000 x 0.75 = 1500
    row({ model: openai, createdAt: at(1) }),     // ignored (would be a hit of 2000 x 1.25)
    row({ model: gemini, createdAt: at(2) }),     // ignored
    row({ model: anthropic, createdAt: at(3) }),  // hit: 2000 x 2.7 = 5400
    row({ model: anthropic, createdAt: at(7) }),  // hit (4 min after at(3)): 5400
    row({ model: openai, createdAt: at(8) }),     // ignored: does not move the last-call time
    row({ model: anthropic, createdAt: at(11) }), // hit (4 min after at(7)): 5400
  ];
  // (3 x 5400 - 1500) / 1e6
  assert.equal(savings.promptCacheEstimate(rows, { [AG]: 2000 }), 0.0147);
  // Only OpenAI calls: the agent qualifies by prefix size but has no Claude call to estimate.
  assert.equal(savings.promptCacheEstimate([row({ model: openai, createdAt: at(0) }), row({ model: openai, createdAt: at(1) })], { [AG]: 2000 }), null);
});

test('summaryEstimate: answers past n, history older than the n/2 most recent, × 0.75 × input', () => {
  const messages = [];
  for (let i = 0; i < 12; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', chars: 400, bytes: 400, inPeriod: true });
  // n = 10: answers at positions 12 only (index 11). History = 10 messages before the prompt; older than 5 → 5 × 100 tokens.
  assert.equal(savings.summaryEstimate([{ inputPrice: 2, messages }], 10), Number((500 * 0.75 * 2 / 1e6).toFixed(6)));
  assert.equal(savings.summaryEstimate([{ inputPrice: 2, messages: messages.map(item => ({ ...item, inPeriod: false })) }], 10), 0);
});

// ---------------------------------------------------------------------------------------------------------------
// Endpoints

function fakePrisma(state) {
  const matches = (item, where = {}) => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(item[key]);
      if ('not' in value) return item[key] !== value.not;
      if ('gte' in value || 'lt' in value) return (!value.gte || item[key] >= value.gte) && (!value.lt || item[key] < value.lt);
      return true;
    }
    return item[key] === value;
  });
  const bindings = () => state.agentModels;
  const prisma = {
    aiUsage: {
      count: async ({ where }) => state.usage.filter(item => item.tenantId === where.tenantId && item.agentId === where.agentId && item.createdAt >= where.createdAt.gte && (item.lowDetailImages > 0 || item.highDetailImages > 0)).length,
      findMany: async ({ where, orderBy, take, cursor, skip }) => {
        state.usageQueries = (state.usageQueries ?? 0) + 1;
        assert.deepEqual(orderBy, [{ createdAt: 'asc' }, { id: 'asc' }]);
        const sorted = state.usage.filter(item => matches(item, where)).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const start = cursor ? sorted.findIndex(item => item.id === cursor.id) + (skip ?? 0) : 0;
        return sorted.slice(start, start + take);
      },
    },
    optimizationEvent: {
      findMany: async ({ where }) => state.events.filter(item => matches(item, where)),
      findFirst: async ({ where }) => [...state.events].filter(item => matches(item, where)).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
      create: async ({ data }) => { const event = { ...data, createdAt: new Date(Date.now() + state.events.length) }; state.events.push(event); return event; },
    },
    auditLog: { groupBy: async () => [], create: async ({ data }) => { state.audits.push(data); return data; } },
    aiModel: {
      findMany: async ({ where }) => state.models.filter(item => where.id.in.includes(item.id)),
      findFirst: async ({ where }) => state.models.find(item => item.slug === where.slug && item.active === where.active) ?? null,
      findUnique: async ({ where }) => state.models.find(item => item.id === where.id) ?? null,
    },
    agent: {
      findMany: async () => state.agents.map(agent => ({ ...agent, models: bindings().filter(b => b.agentId === agent.id).map(b => ({ isPrimary: b.isPrimary, model: { id: b.modelId, slug: state.models.find(m => m.id === b.modelId).slug } })) })),
      findFirst: async ({ where }) => state.agents.find(agent => agent.id === where.id && agent.tenantId === where.tenantId) ?? null,
    },
    agentTool: { findMany: async () => [], count: async () => state.tools },
    agentModel: {
      findMany: async ({ where }) => bindings().filter(b => b.agentId === where.agentId).map(b => ({ isPrimary: b.isPrimary, model: { id: b.modelId, slug: state.models.find(m => m.id === b.modelId).slug } })),
      deleteMany: async ({ where }) => { state.agentModels = state.agentModels.filter(b => b.agentId !== where.agentId); },
      create: async ({ data }) => { state.agentModels.push(data); return data; },
    },
    conversation: { findMany: async () => [] },
    $queryRaw: async () => [],
    $transaction: async fn => { if (state.beforeTransaction) state.beforeTransaction(); return fn(prisma); },
  };
  return prisma;
}
function build(overrides = {}) {
  const state = {
    usage: [{ ...row({ inputTokens: 1000, outputTokens: 100, cost: 0.0012 }), id: 'u0', model: undefined, status: 'COMPLETED' }],
    events: [], audits: [], tools: 0,
    models: [
      { id: M_OLD, slug: 'openai/gpt-4o', inputPrice: 2.5, outputPrice: 10, active: true, capabilities: { supportsTools: true } },
      { id: M_NEW, slug: 'openai/gpt-4o-mini', inputPrice: 0.15, outputPrice: 0.6, active: true, capabilities: {} },
      { id: M_OFF, slug: 'openai/old', inputPrice: 1, outputPrice: 1, active: false, capabilities: {} },
    ],
    agents: [{ id: AG, tenantId: T1, name: 'Agente', systemPrompt: 'Prompt', maxTokens: 4000, advancedReasoning: false }],
    agentModels: [{ agentId: AG, modelId: M_OLD, isPrimary: true }],
    ...overrides,
  };
  const access = { allowed: async () => state.allowed ?? null };
  const service = new SgdmSavingsService(fakePrisma(state), undefined, access);
  if (overrides.batchSize) service.batchSize = overrides.batchSize;
  return { controller: new SgdmOptimizationController(service), state, service };
}
const auth = key => ({ headers: { authorization: 'Bearer ' + key } });
const period = { inicio: '2026-10-01', fim: '2026-10-30' };

test('savings endpoint: 404 without a key, 401 with a wrong one, 400 past 92 days', async () => {
  delete process.env.SGDM_INTEGRATION_KEY;
  await assert.rejects(build().controller.savings(auth('x'), period), NotFoundException);
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  await assert.rejects(build().controller.savings(auth('wrong'), period), UnauthorizedException);
  await assert.rejects(build().controller.savings(auth('secret'), { inicio: '2026-01-01', fim: '2026-04-03' }), BadRequestException); // 93 days
  await build().controller.savings(auth('secret'), { inicio: '2026-01-01', fim: '2026-04-02' }); // 92 days
  await assert.rejects(build().controller.savings(auth('secret'), { inicio: '2026-02-30', fim: '2026-03-01' }), BadRequestException);
  await assert.rejects(build().controller.savings(auth('secret'), { ...period, tenantId: 'x' }), BadRequestException);
  await assert.rejects(build().controller.savings(auth('secret'), { ...period, saidaCurta: '-1' }), BadRequestException);
});

test('savings endpoint: numbers only, never a content/summary/message key; unmeasurable is null', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const result = await build().controller.savings(auth('secret'), { ...period, tenantId: T1 });
  const keys = [];
  (function walk(value) { if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { keys.push(key); walk(inner); } })(result);
  for (const forbidden of ['content', 'summary', 'message', 'systemPrompt']) assert.ok(!keys.includes(forbidden), forbidden);
  const item = result.prefeituras[T1];
  assert.equal(item.limiteSaida.realUsd, null);
  assert.equal(item.modeloCaro.estimativaUsd, null);
  assert.equal(item.resumoHistorico.estimativaUsd, null);
  assert.equal(result.agentes[0].chamadas, 1);
  assert.equal(result.agentes[0].modeloSlug, 'openai/gpt-4o');
  assert.equal(result.agentes[0].raciocinioAvancado, false);
  assert.deepEqual(result.usuarios[0].porModelo, [{ modeloSlug: 'openai/gpt-4o-mini', chamadas: 1, curtas: 1, custoUsd: 0.0012 }]);
});

test('PATCH modelo: other prefeitura 404; unreleased or inactive 400; tools need supportsTools', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  await assert.rejects(build().controller.swap(auth('secret'), AG, { tenantId: T2, slug: 'openai/gpt-4o-mini' }), NotFoundException);
  await assert.rejects(build().controller.swap(auth('secret'), AG, { tenantId: T1, slug: 'openai/old' }), { message: MODEL_NOT_RELEASED });
  await assert.rejects(build({ allowed: { slugs: ['openai/gpt-4o'], defaultSlug: null } }).controller.swap(auth('secret'), AG, { tenantId: T1, slug: 'openai/gpt-4o-mini' }), { message: MODEL_NOT_RELEASED });
  await assert.rejects(build({ tools: 1 }).controller.swap(auth('secret'), AG, { tenantId: T1, slug: 'openai/gpt-4o-mini' }), { message: MODEL_WITHOUT_TOOLS });
  await assert.rejects(build().controller.swap(auth('wrong'), AG, { tenantId: T1, slug: 'openai/gpt-4o-mini' }), UnauthorizedException);
});

test('PATCH modelo: success creates the event and the audit; desfazer returns to the previous model', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const { controller, state } = build({ allowed: { slugs: ['openai/gpt-4o', 'openai/gpt-4o-mini'], defaultSlug: null } });
  assert.deepEqual(await controller.swap(auth('secret'), AG, { tenantId: T1, slug: 'openai/gpt-4o-mini' }), { agentId: AG, from: 'openai/gpt-4o', to: 'openai/gpt-4o-mini' });
  assert.deepEqual(state.agentModels, [{ agentId: AG, modelId: M_NEW, isPrimary: true }]);
  assert.equal(state.events.length, 1);
  assert.deepEqual({ ...state.events[0], createdAt: undefined }, { tenantId: T1, agentId: AG, kind: 'TROCA_MODELO', fromModelId: M_OLD, toModelId: M_NEW, createdAt: undefined });
  assert.deepEqual(state.audits[0], { tenantId: T1, userId: null, event: 'agent.model_changed_by_platform', resource: 'agents', resourceId: AG, metadata: { from: 'openai/gpt-4o', to: 'openai/gpt-4o-mini' } });
  assert.deepEqual(await controller.undo(auth('secret'), AG, { tenantId: T1 }), { agentId: AG, from: 'openai/gpt-4o-mini', to: 'openai/gpt-4o' });
  assert.deepEqual(state.agentModels, [{ agentId: AG, modelId: M_OLD, isPrimary: true }]);
  assert.equal(state.events.length, 2);
  assert.equal(state.events[1].kind, UNDO_KIND);
  assert.equal(state.audits.length, 2);
  // An undo is not undone in turn.
  await assert.rejects(controller.undo(auth('secret'), AG, { tenantId: T1 }), { message: NOTHING_TO_UNDO });
  assert.equal(state.events.length, 2);
});

test('desfazer: no swap is 400; previous model no longer active is 400', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  await assert.rejects(build().controller.undo(auth('secret'), AG, { tenantId: T1 }), BadRequestException);
  const { controller, state } = build();
  await controller.swap(auth('secret'), AG, { tenantId: T1, slug: 'openai/gpt-4o-mini' });
  state.models[0].active = false;
  await assert.rejects(controller.undo(auth('secret'), AG, { tenantId: T1 }), { message: PREVIOUS_MODEL_NOT_RELEASED });
  assert.equal(state.events.length, 1);
  // Active but no longer released to the prefeitura: the same clear refusal.
  state.models[0].active = true; state.allowed = { slugs: ['openai/gpt-4o-mini'], defaultSlug: null };
  await assert.rejects(controller.undo(auth('secret'), AG, { tenantId: T1 }), { message: PREVIOUS_MODEL_NOT_RELEASED });
  assert.equal(state.events.length, 1);
});

test('agentes[].ultimaTroca: offered after a swap, gone after the undo or a later manual change', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const { controller, state } = build();
  assert.equal((await controller.savings(auth('secret'), period)).agentes[0].ultimaTroca, null);
  await controller.swap(auth('secret'), AG, { tenantId: T1, slug: 'openai/gpt-4o-mini' });
  // Events are read up to the period's end: place the swap inside it (independent of the clock).
  state.events[0].createdAt = at(10);
  const offered = (await controller.savings(auth('secret'), period)).agentes[0];
  assert.deepEqual(offered.ultimaTroca, { de: 'openai/gpt-4o', para: 'openai/gpt-4o-mini', em: at(10).toISOString() });
  // Changed by hand since: the undo would be refused, so it is not offered.
  state.agentModels = [{ agentId: AG, modelId: M_OFF, isPrimary: true }];
  assert.equal((await controller.savings(auth('secret'), period)).agentes[0].ultimaTroca, null);
  // Undone: the latest event is the undo, never offered again.
  state.agentModels = [{ agentId: AG, modelId: M_NEW, isPrimary: true }];
  await controller.undo(auth('secret'), AG, { tenantId: T1 });
  state.events[1].createdAt = at(20);
  assert.equal((await controller.savings(auth('secret'), period)).agentes[0].ultimaTroca, null);
});

test('PATCH modelo: an agent that received images needs a model with supportsVision', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const recent = new Date(Date.now() - 86_400_000);
  const usage = [{ ...row({ inputTokens: 10, lowDetailImages: 1, createdAt: recent }), id: 'img', status: 'COMPLETED' }];
  const vision = build({ usage });
  await assert.rejects(vision.controller.swap(auth('secret'), AG, { tenantId: T1, slug: 'openai/gpt-4o-mini' }), { message: MODEL_WITHOUT_VISION });
  assert.equal(vision.state.events.length, 0);
  vision.state.models[1].capabilities = { supportsVision: true };
  assert.equal((await vision.controller.swap(auth('secret'), AG, { tenantId: T1, slug: 'openai/gpt-4o-mini' })).to, 'openai/gpt-4o-mini');
  // Images older than 30 days do not count.
  const old = build({ usage: [{ ...usage[0], createdAt: new Date(Date.now() - 31 * 86_400_000) }] });
  assert.equal((await old.controller.swap(auth('secret'), AG, { tenantId: T1, slug: 'openai/gpt-4o-mini' })).to, 'openai/gpt-4o-mini');
  // The savings body says the agent receives images.
  vision.state.usage[0].createdAt = at(5);
  assert.equal((await vision.controller.savings(auth('secret'), period)).agentes[0].recebeImagens, true);
});

// ---------------------------------------------------------------------------------------------------------------
// Fix round 1

test('accumulators: thousands of rows stay linear', () => {
  const rows = [];
  for (let i = 0; i < 20000; i++) rows.push(row({ agentId: 'agent-' + (i % 3), requestHash: 'h' + (i % 500), cost: 0.001, createdAt: at(i / 10) }));
  const started = Date.now();
  savings.promptCacheEstimate(rows, { 'agent-0': 2000, 'agent-1': 2000, 'agent-2': 2000 });
  savings.exactCacheEstimate(rows, 3600);
  savings.modelSwapSavings(rows, [{ agentId: 'agent-0', kind: 'TROCA_MODELO', createdAt: at(1), fromModelId: M_OLD, toModelId: M_NEW, from: { slug: 'openai/gpt-4o', inputPrice: 2.5, outputPrice: 10 } }]);
  assert.ok(Date.now() - started < 1500, 'took ' + (Date.now() - started) + ' ms');
});

/** Mixed fixture over two prefeituras, every kind and flag, a swap and its undo. */
function fixture() {
  const models = [
    { id: M_OLD, slug: 'openai/gpt-4o', inputPrice: 2.5, outputPrice: 10, cachedInputPrice: 1.25, cacheWriteInputPrice: null, active: true, capabilities: {} },
    { id: M_NEW, slug: 'anthropic/claude', inputPrice: 3, outputPrice: 15, cachedInputPrice: 0.3, cacheWriteInputPrice: 3.75, active: true, capabilities: {} },
  ];
  const agents = [AG, '22222222-2222-4222-8222-222222222222'];
  const usage = [];
  let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 400; i++) {
    const model = models[i % 2];
    usage.push({
      id: 'u' + String(i).padStart(4, '0'), status: i % 37 === 0 ? 'PENDING' : 'COMPLETED',
      tenantId: i % 5 === 0 ? T2 : T1, agentId: agents[i % 2], userId: i % 3 ? U1 : null, modelId: model.id,
      inputTokens: Math.floor(rnd() * 5000), outputTokens: Math.floor(rnd() * 900), cost: Number((rnd() / 100).toFixed(6)),
      cachedInputTokens: Math.floor(rnd() * 1000), cacheWriteInputTokens: Math.floor(rnd() * 300), cacheHit: i % 11 === 0,
      historySavedTokens: i % 4 ? 0 : 1500, lowDetailImages: i % 6 === 0 ? 1 : 0, highDetailImages: i % 9 === 0 ? 2 : 0,
      requestHash: i % 3 === 0 ? 'h' + (i % 7) : null, kind: i % 13 === 0 ? 'resumo' : 'resposta', truncated: i % 17 === 0,
      // Several rows share a timestamp so the (createdAt, id) order and the cursor are exercised.
      createdAt: at(Math.floor(i / 3) * 2),
    });
  }
  const events = [
    { tenantId: T1, agentId: AG, kind: 'TROCA_MODELO', fromModelId: M_OLD, toModelId: M_NEW, createdAt: at(100) },
    { tenantId: T1, agentId: AG, kind: 'TROCA_MODELO', fromModelId: M_NEW, toModelId: M_OLD, createdAt: at(200) },
  ];
  return { usage, models, events, agents: agents.map(id => ({ id, tenantId: T1, name: 'A', systemPrompt: 'P', maxTokens: 4000, advancedReasoning: false })), agentModels: [] };
}

test('streamed in batches = whole-list reference formulas, for any batch size', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const query = { inicio: '2026-09-01', fim: '2026-11-30' };
  const results = [];
  for (const batchSize of [7, 64, 5000]) {
    const { controller, state } = build({ ...fixture(), batchSize });
    results.push(await controller.savings(auth('secret'), query));
    if (batchSize === 7) assert.ok(state.usageQueries > 50);
  }
  assert.deepEqual(results[0], results[2]);
  assert.deepEqual(results[1], results[2]);
  const data = fixture();
  const byId = new Map(data.models.map(model => [model.id, model]));
  const all = data.usage.filter(item => item.status !== 'PENDING').map(item => ({ ...item, model: byId.get(item.modelId) }));
  const events = data.events.map(event => ({ ...event, from: byId.get(event.fromModelId) }));
  for (const tenantId of [T1, T2]) {
    const rows = all.filter(item => item.tenantId === tenantId);
    const item = results[2].prefeituras[tenantId];
    assert.equal(item.cachePrompt.realUsd, savings.promptCacheSavings(rows));
    assert.equal(item.cacheExato.realUsd, savings.exactCacheSavings(rows));
    assert.equal(item.cacheExato.estimativaUsd, savings.exactCacheEstimate(rows, 3600));
    assert.equal(item.resumoHistorico.realUsd, savings.summarySavings(rows));
    assert.deepEqual([item.imagensBaixa.realUsd, item.imagensBaixa.estimativaUsd], Object.values(savings.imageSavings(rows)));
    assert.equal(item.modeloCaro.realUsd, savings.modelSwapSavings(rows, tenantId === T1 ? events : []));
    assert.equal(item.cacheExato.acertos, rows.filter(r => r.cacheHit).length);
    assert.equal(item.cachePrompt.tokensLidos, rows.filter(r => !r.cacheHit).reduce((sum, r) => sum + r.cachedInputTokens, 0));
  }
  assert.ok(results[2].prefeituras[T1].modeloCaro.realUsd > 0);
  assert.ok(results[2].prefeituras[T1].cacheExato.estimativaUsd > 0);
});

test('exact-cache hits are left out of token totals and medians, kept in US$', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const usage = [
    { ...row({ inputTokens: 1000, outputTokens: 100, cachedInputTokens: 200, cost: 0.01 }), id: 'a', status: 'COMPLETED' },
    { ...row({ inputTokens: 9000, outputTokens: 900, cachedInputTokens: 800, cost: 0.02, cacheHit: true }), id: 'b', status: 'COMPLETED', createdAt: at(1) },
  ];
  const result = await build({ usage }).controller.savings(auth('secret'), period);
  const agent = result.agentes[0];
  assert.deepEqual([agent.chamadas, agent.tokensEntrada, agent.tokensCache, agent.tokensSaida, agent.saidaMediana, agent.entradaMediana, agent.custoUsd], [2, 1000, 200, 100, 100, 1000, 0.03]);
  assert.equal(result.prefeituras[T1].cachePrompt.tokensLidos, 200);
  assert.equal(result.usuarios[0].porModelo[0].custoUsd, 0.03);
});

test('tenantId filter leaves out the other prefeitura rows', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const usage = [
    { ...row({ inputTokens: 10, cost: 0.5 }), id: 'a', status: 'COMPLETED' },
    { ...row({ inputTokens: 10, cost: 0.7, tenantId: T2, userId: '44444444-4444-4444-8444-222222222222' }), id: 'b', status: 'COMPLETED' },
  ];
  const result = await build({ usage }).controller.savings(auth('secret'), { ...period, tenantId: T1 });
  assert.deepEqual(Object.keys(result.prefeituras), [T1]);
  assert.deepEqual(result.usuarios.map(user => user.tenantId), [T1]);
  assert.equal(result.agentes[0].custoUsd, 0.5);
});

test('PATCH modelo: advanced reasoning needs a reasoning model; same model is 400', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const reasoning = build({ agents: [{ id: AG, tenantId: T1, name: 'A', systemPrompt: 'P', maxTokens: 4000, advancedReasoning: true }] });
  await assert.rejects(reasoning.controller.swap(auth('secret'), AG, { tenantId: T1, slug: 'openai/gpt-4o-mini' }), { message: MODEL_WITHOUT_REASONING });
  assert.equal(reasoning.state.events.length, 0);
  reasoning.state.models[1].capabilities = { supportsReasoning: true };
  assert.equal((await reasoning.controller.swap(auth('secret'), AG, { tenantId: T1, slug: 'openai/gpt-4o-mini' })).to, 'openai/gpt-4o-mini');
  await assert.rejects(build().controller.swap(auth('secret'), AG, { tenantId: T1, slug: 'openai/gpt-4o' }), { message: 'O agente já usa este modelo.' });
});

test('desfazer: refused when the model changed since the swap, before and after the lock', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const third = { id: '33333333-3333-4333-8333-444444444444', slug: 'openai/gpt-4.1', inputPrice: 2, outputPrice: 8, active: true, capabilities: {} };
  const changed = build();
  changed.state.models.push(third);
  await changed.controller.swap(auth('secret'), AG, { tenantId: T1, slug: 'openai/gpt-4o-mini' });
  changed.state.agentModels = [{ agentId: AG, modelId: third.id, isPrimary: true }];
  await assert.rejects(changed.controller.undo(auth('secret'), AG, { tenantId: T1 }), { message: MODEL_CHANGED_SINCE });
  // Changed between the check and the lock: the transaction re-checks.
  const race = build();
  race.state.models.push(third);
  await race.controller.swap(auth('secret'), AG, { tenantId: T1, slug: 'openai/gpt-4o-mini' });
  race.state.beforeTransaction = () => { race.state.agentModels = [{ agentId: AG, modelId: third.id, isPrimary: true }]; };
  await assert.rejects(race.controller.undo(auth('secret'), AG, { tenantId: T1 }), { message: MODEL_CHANGED_SINCE });
  assert.equal(race.state.events.length, 1);
  assert.deepEqual(race.state.agentModels, [{ agentId: AG, modelId: third.id, isPrimary: true }]);
});
