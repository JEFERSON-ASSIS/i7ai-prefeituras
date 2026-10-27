const { quotaFixture } = require('./helpers/quota-fixture.cjs');
const { THEME_VERSION } = require('../dist/sgdm/themes');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
require('reflect-metadata');
const { AiGatewayService } = require('../dist/ai/ai-gateway.service');
const { AiGatewayController } = require('../dist/ai/ai-gateway.controller');
const { AgentToolsService } = require('../dist/ai/agent-tools.service');
const { ToolsService } = require('../dist/tools/tools.service');
const { McpService } = require('../dist/mcp/mcp.service');

const savedFetch = global.fetch;
const envKeys = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AI_GATEWAY_URL', 'AI_GATEWAY_API_KEY', 'OMNIROUTER_BASE_URL', 'OMNIROUTER_API_KEY', 'NODE_ENV', 'TOOLS_ALLOW_PRIVATE_NETWORK', 'TOOL_SECRET_FIXTURE'];
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
test.beforeEach(() => { envKeys.forEach((key) => delete process.env[key]); });
test.afterEach(() => { global.fetch = savedFetch; envKeys.forEach((key) => { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }); });

function fixture(bindings = []) {
  const records = { messages: [], usage: [], audit: [], conversations: [], bindings, authorized: [] };
  const agent = { id: 'agent-a', tenantId: 'tenant-a', status: 'ACTIVE', name: 'Analista', systemPrompt: 'Use dados públicos.', temperature: 0.2, maxTokens: 500, advancedReasoning: false,
    models: [{ isPrimary: true, model: { id: 'model-a', slug: 'gpt-4o-mini', inputPrice: 0.15, outputPrice: 0.60, provider: { name: 'OpenAI', slug: 'openai', config: null } } }] };
  const prisma = {
    agent: { findFirst: async () => agent }, license: { findFirst: async () => null },
    conversation: { findFirst: async () => null, create: async ({ data }) => { records.conversations.push(data); return { id: 'conversation-a' }; } },
    message: { create: async ({ data }) => { const row = { id: 'message-' + records.messages.length, createdAt: new Date(), ...data }; records.messages.push(row); return row; } },
    aiUsage: { create: async ({ data }) => { records.usage.push(data); return data; } },
    auditLog: { create: async ({ data }) => { records.audit.push(data); return data; } },
    agentTool: {
      findMany: async ({ where }) => { assert.equal(where.agent.tenantId, 'tenant-a'); assert.equal(where.tool.tenantId, 'tenant-a'); assert.equal(where.enabled, true); return records.bindings; },
      findFirst: async ({ where }) => {
        records.authorized.push(where);
        return records.bindings.find((binding) => binding.tool.id === where.toolId && binding.enabled && binding.tool.status === 'ACTIVE' && binding.tool.tenantId === where.tool.tenantId && where.agent.tenantId === 'tenant-a' && where.agentId === 'agent-a') || null;
      },
    },
  };
  prisma.$transaction = async (callback) => callback(prisma);
  const tools = new ToolsService(prisma); const mcp = new McpService(prisma, tools); const runtime = new AgentToolsService(prisma, tools, mcp);
  const service = new AiGatewayService(prisma, { searchForAgent: async () => [] }, runtime, quotaFixture(prisma, records));
  return { records, service, runtime, prisma, agent };
}

function modelPayload(text = 'Resposta final', output) {
  return { id: 'response-fixture', object: 'response', status: 'completed', output: output || [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 20 } };
}
function jsonResponse(payload) { return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
function sseResponse(events) { return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); }
function toolPayload(name, args, callId) { return modelPayload('', [{ type: 'function_call', id: 'item-' + callId, call_id: callId, name, arguments: JSON.stringify(args), status: 'completed' }]); }

test('real SDK SSE deltas arrive before committed complete payload and final usage is saved', async () => {
  const { service, records } = fixture(); const events = []; let request;
  process.env.OPENAI_API_KEY = 'fake-never-sent';
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return sseResponse([
      { type: 'response.output_text.delta', delta: 'Resposta ', output_index: 0, content_index: 0, sequence_number: 1 },
      { type: 'response.output_text.delta', delta: 'final', output_index: 0, content_index: 0, sequence_number: 2 },
      { type: 'response.completed', response: modelPayload(), sequence_number: 3 },
    ]);
  };
  await service.chatStream('agent-a', 'tenant-a', { message: 'Resuma' }, 'user-a', (event, payload) => {
    if (event === 'delta') assert.equal(records.messages.length, 0);
    if (event === 'complete') { assert.equal(records.messages.length, 2); assert.equal(records.usage.length, 1); assert.equal(payload.conversationId, 'conversation-a'); }
    events.push({ event, payload });
  });
  assert.equal(request.stream, true); assert.deepEqual(events.map((item) => item.event), ['delta', 'delta', 'complete']);
  assert.equal(events[0].payload.text + events[1].payload.text, 'Resposta final');
  assert.equal(records.usage[0].inputTokens, 100); assert.equal(records.usage[0].outputTokens, 20);
});

test('disconnect cancellation stops generation and never saves partial assistant text', async () => {
  const { service, records } = fixture(); const abort = new AbortController(); const events = [];
  process.env.OPENAI_API_KEY = 'fake-never-sent';
  global.fetch = async () => sseResponse([{ type: 'response.output_text.delta', delta: 'Parcial', sequence_number: 1 }, { type: 'response.completed', response: modelPayload('Parcial final'), sequence_number: 2 }]);
  await assert.rejects(() => service.chatStream('agent-a', 'tenant-a', { message: 'Resuma' }, 'user-a', (event) => {
    events.push(event); if (event === 'delta') abort.abort(new DOMException('disconnected', 'AbortError'));
  }, abort.signal), { name: 'AbortError' });
  assert.deepEqual(events, ['delta']); assert.equal(records.messages.length, 0); assert.equal(records.conversations.length, 0); assert.ok(records.usage.every(row => row.status === 'FAILED' && !row.usageMeasured));
});

test('provider stream without completion fails instead of saving the received fragment', async () => {
  const { service, records } = fixture(); process.env.OPENAI_API_KEY = 'fake-never-sent';
  global.fetch = async () => sseResponse([{ type: 'response.output_text.delta', delta: 'Parcial', sequence_number: 1 }]);
  await assert.rejects(() => service.chatStream('agent-a', 'tenant-a', { message: 'Resuma' }, 'user-a', () => {}), /sem confirmação/);
  assert.equal(records.messages.length, 0); assert.ok(records.usage.every(row => row.status === 'FAILED' && !row.usageMeasured));
});

test('incomplete SSE records provider counters before rejecting partial response', async () => {
  const { service, records } = fixture(); process.env.OPENAI_API_KEY = 'fake-never-sent';
  global.fetch = async () => sseResponse([{ type: 'response.incomplete', response: { ...modelPayload(), status: 'incomplete', usage: { input_tokens: 37, output_tokens: 11 } }, sequence_number: 1 }]);
  await assert.rejects(() => service.chatStream('agent-a', 'tenant-a', { message: 'Resuma' }, 'user-a', () => {}), /interrompeu/);
  assert.equal(records.messages.length, 0); assert.equal(records.usage.length, 1);
  assert.equal(records.usage[0].inputTokens, 37); assert.equal(records.usage[0].outputTokens, 11);
  assert.equal(records.usage[0].status, 'FAILED'); assert.equal(records.usage[0].usageMeasured, true);
  assert.equal(records.reservations[0].reservedTokens, 0n);
});

test('JSON gateway streaming emits only genuine completion without slicing a fabricated stream', async () => {
  const { service, records } = fixture(); const events = [];
  process.env.AI_GATEWAY_URL = 'https://gateway.invalid';
  global.fetch = async () => jsonResponse({ answer: 'Resposta do gateway', usage: { inputTokens: 10, outputTokens: 5 } });
  await service.chatStream('agent-a', 'tenant-a', { message: 'Resuma' }, 'user-a', (event) => { events.push(event); assert.equal(records.messages.length, 2); });
  assert.deepEqual(events, ['complete']);
  assert.equal(records.conversations[0].theme, 'texto'); assert.equal(records.conversations[0].themeVersion, THEME_VERSION);
});

test('gateway null or primitive JSON returns an explicit provider contract error without saving history', async () => {
  const { service, records } = fixture(); process.env.AI_GATEWAY_URL = 'https://gateway.invalid';
  for (const payload of [null, 'unexpected', [], 42]) {
    global.fetch = async () => jsonResponse(payload);
    await assert.rejects(() => service.chat('agent-a', 'tenant-a', { message: 'Resuma' }, 'user-a'), /objeto JSON válido/);
  }
  assert.equal(records.messages.length, 0); assert.ok(records.usage.every(row => row.status === 'FAILED' && !row.usageMeasured));
});

test('SSE controller encodes deltas and aborts request when the response closes', async () => {
  const response = new EventEmitter(); const frames = [];
  response.setHeader = () => {}; response.flushHeaders = () => {}; response.write = (frame) => { frames.push(frame); return true; }; response.end = () => { response.writableEnded = true; }; response.writableEnded = false; response.destroyed = false;
  const controller = new AiGatewayController({ chatStream: async (_agent, _tenant, _body, userId, emit, signal) => { assert.equal(userId, 'user-a'); emit('delta', { text: 'oi' }); response.emit('close'); assert.equal(signal.aborted, true); throw new DOMException('closed', 'AbortError'); } });
  await controller.stream('agent-a', { user: { tenantId: 'tenant-a', sub: 'user-a' } }, { message: 'oi' }, response);
  assert.match(frames[0], /event: delta\ndata: \{"text":"oi"\}/); assert.equal(frames.some((frame) => frame.includes('event: complete')), false);
  assert.equal(response.listenerCount('close'), 0);
});

test('SSE controller sends a sanitized error frame and ends the stream when provider fails', async () => {
  const { ServiceUnavailableException } = require('@nestjs/common');
  const response = new EventEmitter(); const frames = [];
  response.setHeader = () => {}; response.flushHeaders = () => {}; response.write = (frame) => { frames.push(frame); return true; }; response.end = () => { response.writableEnded = true; }; response.writableEnded = false; response.destroyed = false;
  const controller = new AiGatewayController({ chatStream: async () => { throw new ServiceUnavailableException('Provedor indisponível'); } });
  await controller.stream('agent-a', { user: { tenantId: 'tenant-a', sub: 'user-a' } }, { message: 'oi' }, response);
  assert.match(frames[0], /event: error\ndata: \{"message":"Provedor indisponível"\}/);
  assert.equal(response.writableEnded, true); assert.equal(response.listenerCount('close'), 0);
});

test('model function request outside linked tool catalog is forbidden and does not save a fake answer', async () => {
  const { service, records } = fixture(); process.env.OPENAI_API_KEY = 'fake-never-sent';
  global.fetch = async () => jsonResponse(toolPayload('not_bound', {}, 'call-1'));
  await assert.rejects(() => service.chat('agent-a', 'tenant-a', { message: 'Execute' }, 'user-a'), /não está vinculada/);
  assert.equal(records.messages.length, 0); assert.equal(records.audit.length, 0);
});

async function localToolServer(t) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    let input = ''; for await (const chunk of request) input += chunk;
    const payload = input ? JSON.parse(input) : {}; calls.push({ path: request.url, method: request.method, payload });
    if (request.method === 'DELETE') { response.writeHead(204); response.end(); return; }
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/http') { response.end(JSON.stringify({ value: 42, echoSecret: request.headers.authorization, token: 'redact-this', received: payload })); return; }
    if (payload.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
    let result;
    if (payload.method === 'initialize') { response.setHeader('Mcp-Session-Id', 'fixture-session'); result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }; }
    else if (payload.method === 'tools/list') result = { tools: [{ name: 'lookup_budget', description: 'Consulta orçamento', inputSchema: { type: 'object', properties: { year: { type: 'integer' } }, required: ['year'], additionalProperties: false } }] };
    else if (payload.method === 'tools/call') result = { content: [{ type: 'text', text: 'Orçamento: 42' }], isError: false };
    else { response.writeHead(400); response.end(); return; }
    response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, calls };
}
function binding(id, type, endpoint) { return { enabled: true, rateLimitPerMinute: 60, tool: { id, tenantId: 'tenant-a', name: type, type, status: 'ACTIVE', allowedDomains: ['127.0.0.1'], config: { endpoint, method: 'POST', ...(type === 'MCP_SERVER' ? { transport: 'streamable-http', allowedToolNames: ['lookup_budget'] } : {}) }, credentials: [{ label: 'Authorization', secretRef: 'TOOL_SECRET_FIXTURE' }] } }; }

test('agent performs actual local HTTP then MCP function calls, rechecks authorization and sums model usage', async (t) => {
  process.env.TOOLS_ALLOW_PRIVATE_NETWORK = 'true'; process.env.TOOL_SECRET_FIXTURE = 'fixture-secret'; process.env.OPENAI_API_KEY = 'fake-never-sent';
  const local = await localToolServer(t);
  const { service, records } = fixture([binding('http-a', 'HTTP_REQUEST', local.endpoint + '/http'), binding('mcp-a', 'MCP_SERVER', local.endpoint + '/mcp')]);
  const modelRequests = []; let round = 0;
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body); modelRequests.push(request);
    const httpFunction = request.tools.find((tool) => tool.name.startsWith('http_'));
    const mcpFunction = request.tools.find((tool) => tool.name.startsWith('mcp_'));
    if (round++ === 0) return jsonResponse(toolPayload(httpFunction.name, { year: 2026 }, 'http-call'));
    if (round === 2) return jsonResponse(toolPayload(mcpFunction.name, { year: 2026 }, 'mcp-call'));
    return jsonResponse(modelPayload('O orçamento consultado é 42.'));
  };
  const result = await service.chat('agent-a', 'tenant-a', { message: 'Consulte o orçamento' }, 'user-a');
  assert.equal(result.answer, 'O orçamento consultado é 42.'); assert.equal(result.toolCalls.length, 2);
  assert.equal(result.usage.inputTokens, 300); assert.equal(result.usage.outputTokens, 60);
  assert.ok(local.calls.some((call) => call.path === '/http' && call.payload.year === 2026));
  assert.ok(local.calls.some((call) => call.payload.method === 'tools/call' && call.payload.params.name === 'lookup_budget'));
  assert.ok(records.authorized.length >= 3); assert.ok(records.authorized.every((where) => where.agent.tenantId === 'tenant-a' && where.tool.tenantId === 'tenant-a'));
  assert.equal(modelRequests[1].input.at(-1).type, 'function_call_output'); assert.equal(modelRequests[1].input.at(-1).call_id, 'http-call');
  assert.equal(modelRequests[2].input.at(-1).call_id, 'mcp-call'); assert.equal(records.messages.length, 2);
  assert.equal(JSON.stringify(records.audit).includes('fixture-secret'), false);
  assert.equal(records.audit.filter((row) => row.event === 'agent.tool_executed').length, 2);
});

test('MCP JSONSchema rejects invalid generated arguments before tools/call', async (t) => {
  process.env.TOOLS_ALLOW_PRIVATE_NETWORK = 'true'; process.env.TOOL_SECRET_FIXTURE = 'fixture-secret'; process.env.OPENAI_API_KEY = 'fake-never-sent';
  const local = await localToolServer(t);
  const { service, records } = fixture([binding('mcp-a', 'MCP_SERVER', local.endpoint + '/mcp')]);
  global.fetch = async (_url, options) => jsonResponse(toolPayload(JSON.parse(options.body).tools[0].name, { year: 'invalid' }, 'bad-call'));
  await assert.rejects(() => service.chat('agent-a', 'tenant-a', { message: 'Consulte' }, 'user-a'), /JSON Schema/);
  assert.equal(local.calls.some((call) => call.payload.method === 'tools/call'), false); assert.equal(records.messages.length, 0);
});

test('streaming tool loop executes the call before final deltas and persists accumulated usage', async (t) => {
  process.env.TOOLS_ALLOW_PRIVATE_NETWORK = 'true'; process.env.TOOL_SECRET_FIXTURE = 'fixture-secret'; process.env.OPENAI_API_KEY = 'fake-never-sent';
  const local = await localToolServer(t); const { service, records } = fixture([binding('http-a', 'HTTP_REQUEST', local.endpoint + '/http')]);
  let round = 0; const events = [];
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body); assert.equal(request.stream, true);
    if (round++ === 0) return sseResponse([{ type: 'response.completed', response: toolPayload(request.tools[0].name, { year: 2026 }, 'stream-call'), sequence_number: 1 }]);
    assert.equal(request.input.at(-1).type, 'function_call_output');
    return sseResponse([{ type: 'response.output_text.delta', delta: 'Valor 42', sequence_number: 1 }, { type: 'response.completed', response: modelPayload('Valor 42'), sequence_number: 2 }]);
  };
  const result = await service.chatStream('agent-a', 'tenant-a', { message: 'Consulte' }, 'user-a', (event) => { events.push(event); });
  assert.deepEqual(events, ['delta', 'complete']); assert.equal(result.usage.inputTokens, 200); assert.equal(result.usage.outputTokens, 40);
  assert.equal(records.messages.length, 2); assert.ok(local.calls.some((call) => call.path === '/http'));
});

test('repeated tool rounds terminate within the eight round/call guard without saving an answer', async (t) => {
  process.env.TOOLS_ALLOW_PRIVATE_NETWORK = 'true'; process.env.TOOL_SECRET_FIXTURE = 'fixture-secret'; process.env.OPENAI_API_KEY = 'fake-never-sent';
  const local = await localToolServer(t); const { service, records } = fixture([binding('http-a', 'HTTP_REQUEST', local.endpoint + '/http')]);
  let round = 0;
  global.fetch = async (_url, options) => jsonResponse(toolPayload(JSON.parse(options.body).tools[0].name, {}, 'loop-' + round++));
  await assert.rejects(() => service.chat('agent-a', 'tenant-a', { message: 'Execute' }, 'user-a'), /oito chamadas/);
  assert.equal(round, 8); assert.ok(local.calls.filter((call) => call.path === '/http').length <= 8); assert.equal(records.messages.length, 0);
});

test('disabled or foreign tenant binding is not exposed; revoked binding is rechecked at execution', async (t) => {
  process.env.TOOLS_ALLOW_PRIVATE_NETWORK = 'true'; process.env.TOOL_SECRET_FIXTURE = 'fixture-secret'; process.env.OPENAI_API_KEY = 'fake-never-sent';
  const local = await localToolServer(t);
  const active = binding('http-a', 'HTTP_REQUEST', local.endpoint + '/http'); const foreign = binding('foreign', 'HTTP_REQUEST', local.endpoint + '/http'); foreign.tool.tenantId = 'tenant-b';
  const disabled = binding('disabled', 'HTTP_REQUEST', local.endpoint + '/http'); disabled.enabled = false;
  const { service, records } = fixture([active, foreign, disabled]);
  global.fetch = async (_url, options) => { const tools = JSON.parse(options.body).tools; assert.equal(tools.length, 1); active.enabled = false; return jsonResponse(toolPayload(tools[0].name, {}, 'revoked')); };
  await assert.rejects(() => service.chat('agent-a', 'tenant-a', { message: 'Execute' }, 'user-a'), /não está autorizada/);
  assert.equal(local.calls.some((call) => call.path === '/http'), false); assert.equal(records.messages.length, 0);
});
