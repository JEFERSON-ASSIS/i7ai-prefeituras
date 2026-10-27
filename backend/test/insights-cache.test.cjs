const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { InsightsController } = require('../dist/insights/insights.controller');

test('painel: respostas do cache exato ficam fora dos totais de tokens e aparecem à parte', async () => {
  const calls = { aggregate: [], groupBy: [], count: [], sql: [] };
  const prisma = {
    agent: { count: async () => 1 }, conversation: { count: async () => 2 }, automation: { count: async () => 3 }, document: { count: async () => 4 },
    aiUsage: {
      aggregate: async args => { calls.aggregate.push(args); return { _sum: { inputTokens: 100, outputTokens: 20, cost: 0.5 }, _count: 7 }; },
      groupBy: async args => { calls.groupBy.push(args); return []; },
      count: async args => { calls.count.push(args); return 3; },
    },
    $queryRaw: async sql => { calls.sql.push(sql); return []; },
    auditLog: { findMany: async () => [] },
    automationExecution: { groupBy: async () => [] },
    aiModel: { findMany: async () => [] },
  };
  const result = await new InsightsController(prisma).dashboard({ user: { tenantId: 'tenant-a' } });
  assert.equal(calls.aggregate[0].where.cacheHit, false);
  assert.equal(calls.groupBy[0].where.cacheHit, false);
  assert.match(calls.sql[0].strings.join('?'), /NOT "cacheHit"/);
  assert.equal(calls.count[0].where.cacheHit, true);
  assert.equal(result.inputTokens, 100); assert.equal(result.requests, 7); assert.equal(result.cacheHits, 3);
});
