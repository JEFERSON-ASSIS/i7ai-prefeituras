const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { NotFoundException, UnauthorizedException, BadRequestException } = require('@nestjs/common');
const savings = require('../dist/sgdm/savings');
const { SgdmOptimizationController } = require('../dist/sgdm/sgdm-optimization.controller');
const { SgdmSavingsService, MODEL_NOT_RELEASED, MODEL_WITHOUT_TOOLS } = require('../dist/sgdm/sgdm-savings.service');

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
  assert.equal(savings.promptCacheEstimate(rows.map(item => ({ ...item, model: row().model })), { [AG]: 2000 }), 0.0018);
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
    aiUsage: { findMany: async ({ where }) => state.usage.filter(item => matches(item, where)) },
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
      findMany: async () => state.agents.map(agent => ({ ...agent, models: bindings().filter(b => b.agentId === agent.id).map(b => ({ isPrimary: b.isPrimary, model: { slug: state.models.find(m => m.id === b.modelId).slug } })) })),
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
    $transaction: async fn => fn(prisma),
  };
  return prisma;
}
function build(overrides = {}) {
  const state = {
    usage: [{ ...row({ inputTokens: 1000, outputTokens: 100, cost: 0.0012 }), model: undefined, status: 'COMPLETED' }],
    events: [], audits: [], tools: 0,
    models: [
      { id: M_OLD, slug: 'openai/gpt-4o', inputPrice: 2.5, outputPrice: 10, active: true, capabilities: { supportsTools: true } },
      { id: M_NEW, slug: 'openai/gpt-4o-mini', inputPrice: 0.15, outputPrice: 0.6, active: true, capabilities: {} },
      { id: M_OFF, slug: 'openai/old', inputPrice: 1, outputPrice: 1, active: false, capabilities: {} },
    ],
    agents: [{ id: AG, tenantId: T1, name: 'Agente', systemPrompt: 'Prompt', maxTokens: 4000 }],
    agentModels: [{ agentId: AG, modelId: M_OLD, isPrimary: true }],
    ...overrides,
  };
  const access = { allowed: async () => state.allowed ?? null };
  const service = new SgdmSavingsService(fakePrisma(state), undefined, access);
  return { controller: new SgdmOptimizationController(service), state };
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
  assert.equal(state.audits.length, 2);
});

test('desfazer: no swap is 400; previous model no longer active is 400', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  await assert.rejects(build().controller.undo(auth('secret'), AG, { tenantId: T1 }), BadRequestException);
  const { controller, state } = build();
  await controller.swap(auth('secret'), AG, { tenantId: T1, slug: 'openai/gpt-4o-mini' });
  state.models[0].active = false;
  await assert.rejects(controller.undo(auth('secret'), AG, { tenantId: T1 }), { message: MODEL_NOT_RELEASED });
  assert.equal(state.events.length, 1);
});
