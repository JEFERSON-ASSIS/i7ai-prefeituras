const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { NotFoundException, UnauthorizedException, BadRequestException } = require('@nestjs/common');
const { SgdmResearchController } = require('../dist/sgdm/sgdm-research.controller');
const { SgdmResearchService } = require('../dist/sgdm/sgdm-research.service');

const A = '11111111-1111-4111-8111-111111111111';
const B = '11111111-1111-4111-8111-222222222222';
const saved = process.env.SGDM_INTEGRATION_KEY;
test.afterEach(() => saved === undefined ? delete process.env.SGDM_INTEGRATION_KEY : process.env.SGDM_INTEGRATION_KEY = saved);

const call = (tenantId, source, status = 'ok', costUsd = source === 'web' ? 0.001 : 0, createdAt = '2026-10-10T12:00:00Z') => ({ tenantId, source, status, costUsd, createdAt: new Date(createdAt) });
const ROWS = [
  call(B, 'web'),
  call(A, 'web'), call(A, 'web'), call(A, 'web'), call(A, 'pncp'), call(A, 'pncp'),
  call(A, 'web', 'erro'), call(A, 'pncp', 'limite'),
  call(A, 'web', 'ok', 0.001, '2026-11-01T00:00:00Z'),
];

// Fake database: interprets the Prisma.Sql values (from, to, optional tenant); the status filter is asserted on the SQL text.
function build(rows = ROWS) {
  const prisma = {
    $queryRaw: async query => {
      assert.match(query.sql, /"status" = 'ok'/);
      const [from, to] = query.values;
      const tenant = query.values.find(value => typeof value === 'string');
      const groups = new Map();
      for (const r of rows.filter(r => r.status === 'ok' && r.createdAt >= from && r.createdAt < to && (!tenant || r.tenantId === tenant))) {
        const g = groups.get(r.tenantId) ?? { tenantId: r.tenantId, internet: 0n, compras: 0n, custo: 0 };
        if (r.source === 'web') g.internet++; else g.compras++;
        g.custo += r.costUsd; groups.set(r.tenantId, g);
      }
      return [...groups.values()];
    },
  };
  return new SgdmResearchController(new SgdmResearchService(prisma));
}
const auth = key => ({ headers: { authorization: 'Bearer ' + key } });
const q = (extra = {}) => ({ inicio: '2026-10-01', fim: '2026-10-31', ...extra });

test('without a configured key the route does not exist (404); wrong key is 401', async () => {
  delete process.env.SGDM_INTEGRATION_KEY;
  await assert.rejects(build().research(auth('x'), q()), NotFoundException);
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  await assert.rejects(build().research(auth('wrong'), q()), UnauthorizedException);
  await assert.rejects(build().research({ headers: {} }, q()), UnauthorizedException);
});

test('invalid period or tenantId is 400', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const c = build();
  await assert.rejects(c.research(auth('secret'), { inicio: '2025-01-01', fim: '2026-01-02' }), BadRequestException);
  await c.research(auth('secret'), { inicio: '2025-01-01', fim: '2025-12-31' });
  await assert.rejects(c.research(auth('secret'), { inicio: '2026-10-31', fim: '2026-10-01' }), BadRequestException);
  await assert.rejects(c.research(auth('secret'), {}), BadRequestException);
  await assert.rejects(c.research(auth('secret'), q({ tenantId: 'nope' })), BadRequestException);
});

test('counts only ok calls per prefeitura, ordered by searches, inside the inclusive period', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const result = await build().research(auth('secret'), q());
  assert.deepEqual(result.periodo, { inicio: '2026-10-01', fim: '2026-10-31' });
  assert.deepEqual(result.porPrefeitura, [
    { tenantId: A, pesquisas: 5, internet: 3, compras: 2, custoUsd: 0.003 },
    { tenantId: B, pesquisas: 1, internet: 1, compras: 0, custoUsd: 0.001 },
  ]);
  assert.equal(result.total, 6);
  assert.equal(result.custoUsd, 0.004);
});

test('tenantId filters to one prefeitura', async () => {
  process.env.SGDM_INTEGRATION_KEY = 'secret';
  const result = await build().research(auth('secret'), q({ tenantId: B }));
  assert.deepEqual(result.porPrefeitura.map(p => p.tenantId), [B]);
  assert.equal(result.total, 1);
  const none = await build().research(auth('secret'), q({ tenantId: '11111111-1111-4111-8111-333333333333' }));
  assert.deepEqual(none, { periodo: none.periodo, total: 0, custoUsd: 0, porPrefeitura: [] });
});
