const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { AiGatewayService } = require('../dist/ai/ai-gateway.service');
const { OPTIMIZATION_DEFAULTS } = require('../dist/sgdm/optimization-defaults');

const envKeys = ['OMNIROUTER_BASE_URL', 'OMNIROUTER_API_KEY'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
test.beforeEach(() => { process.env.OMNIROUTER_BASE_URL = 'https://omni.invalid/v1'; delete process.env.OMNIROUTER_API_KEY; });
test.afterEach(() => envKeys.forEach(key => { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }));

function gateway({ summary = 'Resumo: art. 75.', through = 'm20', disabled = false, ligado = true, withOptimization = true } = {}) {
  const row = { id: 'owned', tenantId: 'tenant-a', userId: 'user-a', agentId: 'agent-a', agent: { id: 'agent-a', name: 'Analista' }, model: null, summary, summaryThroughMessageId: through, summaryModelId: 'haiku', summaryUpdatedAt: new Date(5_000), summaryDisabled: disabled, summaryRejectedThroughMessageId: null, summaryRejections: 0, updatedAt: new Date(9_000), messages: [] };
  const prisma = { conversation: { findFirst: async ({ where }) => (where.id === 'owned' && where.userId === 'user-a' ? row : null) } };
  const calls = [];
  const optimization = { effective: async (tenantId, agentId) => { calls.push([tenantId, agentId]); const cfg = structuredClone(OPTIMIZATION_DEFAULTS); cfg.resumoHistorico.ligado = ligado; return cfg; } };
  const service = new AiGatewayService(prisma, {}, {}, {}, undefined, undefined, undefined, withOptimization ? optimization : undefined, undefined);
  return { service, calls };
}

test('getConversation: summaryActive só quando o resumo entra de fato no prompt (mesma condição do chat)', async () => {
  const on = gateway();
  assert.equal((await on.service.getConversation('tenant-a', 'user-a', 'owned')).summaryActive, true);
  assert.deepEqual(on.calls, [['tenant-a', 'agent-a']]);
  // Summary stored but turned off in the Central, turned off by the user, or no summary: not active.
  assert.equal((await gateway({ ligado: false }).service.getConversation('tenant-a', 'user-a', 'owned')).summaryActive, false);
  assert.equal((await gateway({ disabled: true }).service.getConversation('tenant-a', 'user-a', 'owned')).summaryActive, false);
  const none = gateway({ summary: null, through: null });
  assert.equal((await none.service.getConversation('tenant-a', 'user-a', 'owned')).summaryActive, false);
  assert.equal(none.calls.length, 0);
  // Without the OmniRouter the gateway never sends a summary.
  delete process.env.OMNIROUTER_BASE_URL;
  assert.equal((await gateway().service.getConversation('tenant-a', 'user-a', 'owned')).summaryActive, false);
  // Without SGDM, the defaults apply (summary off by default).
  process.env.OMNIROUTER_BASE_URL = 'https://omni.invalid/v1';
  assert.equal((await gateway({ withOptimization: false }).service.getConversation('tenant-a', 'user-a', 'owned')).summaryActive, OPTIMIZATION_DEFAULTS.resumoHistorico.ligado);
});
