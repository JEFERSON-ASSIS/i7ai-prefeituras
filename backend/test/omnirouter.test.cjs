const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('reflect-metadata');
const { OmniRouterService } = require('../dist/ai/omnirouter.service');
const { quotaFixture } = require('./helpers/quota-fixture.cjs');

const envKeys = ['OMNIROUTER_BASE_URL', 'OMNIROUTER_API_KEY', 'NODE_ENV'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
test.beforeEach(() => {
  envKeys.forEach(key => delete process.env[key]);
  process.env.NODE_ENV = 'test';
  process.env.OMNIROUTER_API_KEY = 'local-test-key-never-used-outside-fixture';
});
test.afterEach(() => envKeys.forEach(key => {
  if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
}));

function fixture(functions = []) {
  const records = { usage: [], executed: [], initialBudgets: [] };
  const prisma = {
    license: { findFirst: async () => null },
    aiUsage: { create: async ({ data }) => { records.usage.push(data); return data; } },
  };
  prisma.$transaction = async callback => callback(prisma);
  const quota = quotaFixture(prisma, records);
  const reserve = quota.reserve.bind(quota);
  quota.reserve = async (scope, budget) => { records.initialBudgets.push(budget); return reserve(scope, budget); };
  const runtime = {
    execute: async (tenantId, agentId, call, available, userId, signal) => {
      signal?.throwIfAborted();
      assert.equal(tenantId, 'tenant-a'); assert.equal(agentId, 'agent-a'); assert.equal(userId, 'user-a');
      assert.equal(available, functions);
      records.executed.push(call);
      return { callId: call.callId, name: call.name, output: JSON.stringify({ result: 42 }) };
    },
  };
  const input = {
    agent: { id: 'agent-a', tenantId: 'tenant-a', temperature: 0.2, maxTokens: 500, advancedReasoning: false },
    model: { slug: 'openai/model-from-catalog', capabilities: null, provider: { config: null } },
    instructions: 'Responda em português. O agente é um analista administrativo.',
    message: 'Analise o orçamento.', history: [{ role: 'user', content: 'Contexto anterior' }, { role: 'assistant', content: 'Resposta anterior' }],
    functions, userId: 'user-a', origin: 'i7ai-chat',
    quotaScope: quota.scope({ tenantId: 'tenant-a', agentId: 'agent-a', modelId: 'model-a', userId: 'user-a', inputPrice: 1, outputPrice: 2 }),
  };
  return { service: new OmniRouterService(runtime, quota), input, records, quota, runtime, prisma };
}

async function provider(t, handler) {
  const requests = []; const failures = [];
  const server = http.createServer(async (request, response) => {
    try {
      let content = ''; for await (const chunk of request) content += chunk;
      const body = content ? JSON.parse(content) : {};
      requests.push({ body, url: request.url, headers: request.headers });
      await handler(body, response, requests.length, request);
    } catch (error) {
      failures.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.OMNIROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}/v1/`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (failures.length) throw failures[0];
  });
  return { requests, server };
}
function completion(text = 'O orçamento é 42.', options = {}) {
  return {
    id: 'fixture-completion', object: 'chat.completion', model: 'openai/model-from-catalog',
    choices: [{ index: 0, finish_reason: options.finishReason || 'stop', message: { role: 'assistant', content: text, ...(options.calls ? { tool_calls: options.calls } : {}) } }],
    ...(options.usage === false ? {} : { usage: options.usage || { prompt_tokens: 30, completion_tokens: 10 } }),
  };
}
function json(response, payload, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload));
}
function chunk(delta = {}, finishReason = null, usage) {
  return { object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
}
function frame(payload, newline = '\n') {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}${newline}${newline}`;
}
function sse(response, frames) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' }); response.end(frames.join(''));
}
function localFunction() {
  return { toolId: 'tool-a', definition: { type: 'function', name: 'lookup_budget', description: 'Consulta orçamento', parameters: { type: 'object', properties: { year: { type: 'integer' } }, required: ['year'] }, strict: false }, validate: () => true };
}
function call(id = 'call-a', name = 'lookup_budget') {
  return { id, type: 'function', function: { name, arguments: '{"year":2026}' } };
}

test('uses real HTTP Chat Completions, central catalog model, agent context, history and real quota', async t => {
  const { service, input, records } = fixture();
  const local = await provider(t, (_body, response) => json(response, completion()));
  const result = await service.generate(input);
  assert.deepEqual(result, { answer: 'O orçamento é 42.', inputTokens: 30, outputTokens: 10, measured: true, toolCalls: [] });
  const request = local.requests[0];
  assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, 'Bearer local-test-key-never-used-outside-fixture');
  assert.equal(request.body.model, input.model.slug); assert.equal(request.body.max_tokens, 500); assert.equal(request.body.stream, false);
  assert.equal(request.body.temperature, undefined); assert.equal(request.body.reasoning, undefined);
  assert.deepEqual(request.body.messages.map(message => message.content), [input.instructions, 'Contexto anterior', 'Resposta anterior', input.message]);
  assert.equal(records.reservations.length, 1); assert.equal(records.reservations[0].reservedTokens, 0n);
  assert.equal(records.usage[0].inputTokens, 30); assert.equal(records.usage[0].usageMeasured, true);
});

test('rejects missing configuration, unsafe URLs and plain HTTP production without contacting a provider', async () => {
  const { service, input, records } = fixture();
  await assert.rejects(service.generate(input), /OMNIROUTER_BASE_URL/);
  for (const url of ['http://public.example/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?api_key=secret', 'https://example.com/v1#key', 'file:///tmp/provider']) {
    process.env.OMNIROUTER_BASE_URL = url;
    await assert.rejects(service.generate(input), /HTTPS/);
  }
  process.env.NODE_ENV = 'production'; process.env.OMNIROUTER_BASE_URL = 'http://localhost:5000/v1';
  await assert.rejects(service.generate(input), /HTTPS/);
  process.env.OMNIROUTER_BASE_URL = 'https://example.invalid/v1'; delete process.env.OMNIROUTER_API_KEY;
  await assert.rejects(service.generate(input), /OMNIROUTER_API_KEY/);
  assert.equal(records.reservations.length, 0);
});

test('model capabilities explicitly gate images, tools and sampling; unsupported reasoning is never ignored', async t => {
  const { service, input, records } = fixture();
  const local = await provider(t, (_body, response) => json(response, completion()));
  input.images = [{ name: 'foto.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' }];
  await assert.rejects(service.generate(input), /imagens habilitado/);
  input.model.capabilities = { supportsVision: true, supportsTemperature: true, contextWindow: 8192 };
  await service.generate(input);
  assert.equal(local.requests[0].body.temperature, 0.2);
  assert.deepEqual(local.requests[0].body.messages.at(-1).content, [{ type: 'text', text: input.message }, { type: 'image_url', image_url: { url: input.images[0].dataUrl, detail: 'auto' } }]);
  input.agent.advancedReasoning = true; input.model.capabilities.supportsReasoning = true;
  await assert.rejects(service.generate(input), /contrato validado/);
  input.agent.advancedReasoning = false; input.model.capabilities.supportsVision = false;
  await assert.rejects(service.generate(input), /imagens habilitado/);
  delete input.images; input.functions = [localFunction()];
  await assert.rejects(service.generate(input), /ferramentas habilitadas/);
  assert.equal(local.requests.length, 1); assert.equal(records.reservations.length, 1);
});

test('uses explicit provider temperature configuration while a model override takes priority', async t => {
  const { service, input } = fixture(); const local = await provider(t, (_body, response) => json(response, completion()));
  input.model.provider.config = { supportsTemperature: true };
  await service.generate(input); assert.equal(local.requests[0].body.temperature, 0.2);
  input.model.capabilities = { supportsTemperature: false };
  await service.generate(input); assert.equal(local.requests[1].body.temperature, undefined);
});

test('strict SSE parses split UTF-8 and CRLF frames, reports genuine deltas and records final consumption', async t => {
  const { service, input, records } = fixture(); const deltas = [];
  input.onDelta = text => { deltas.push(text); assert.equal(records.usage.some(row => row.usageMeasured), false); };
  const body = Buffer.from(': heartbeat\r\n\r\n' + frame(chunk({ role: 'assistant', content: 'Ação ' }), '\r\n') + frame(chunk({ content: 'concluída' }), '\r\n') + frame(chunk({}, 'stop'), '\r\n') + frame({ choices: [], usage: { prompt_tokens: 44, completion_tokens: 8 } }, '\r\n') + frame('[DONE]', '\r\n'));
  const local = await provider(t, async (_body, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const utf8Boundary = body.indexOf(Buffer.from('ç')) + 1;
    response.write(body.subarray(0, utf8Boundary));
    await new Promise(resolve => setTimeout(resolve, 5));
    response.write(body.subarray(utf8Boundary, utf8Boundary + 1));
    response.end(body.subarray(utf8Boundary + 1));
  });
  const result = await service.generate(input);
  assert.equal(result.answer, 'Ação concluída'); assert.deepEqual(deltas, ['Ação ', 'concluída']);
  assert.equal(result.inputTokens, 44); assert.equal(result.outputTokens, 8); assert.equal(result.measured, true);
  assert.equal(local.requests[0].body.stream, true); assert.deepEqual(local.requests[0].body.stream_options, { include_usage: true });
  assert.equal(records.usage.length, 1); assert.equal(records.usage[0].usageMeasured, true); assert.equal(records.reservations[0].reservedTokens, 0n);
});

test('SSE requires terminal finish_reason and DONE; malformed, error and truncated streams cannot return an answer', async t => {
  const samples = [
    [frame(chunk({ content: 'Parcial' }))],
    [frame(chunk({ content: 'Parcial' })), frame(chunk({}, 'stop'))],
    [frame(chunk({ content: 'Parcial' })), frame('[DONE]')],
    [frame(chunk({ content: 'Parcial' })), 'data: {broken-json}\n\n'],
    [frame(chunk({ content: 'Parcial' })), frame({ error: { message: 'UPSTREAM_SECRET_NOT_EXPOSED' } })],
    [frame(chunk({ content: 'Parcial' })), frame(chunk({}, 'stop')), 'data: [DONE]'],
    [frame(chunk({ content: 'Parcial' })), frame(chunk({}, 'stop')), 'event: error\ndata: [DONE]\n\n'],
  ];
  let selected = 0;
  await provider(t, (_body, response) => sse(response, samples[selected++]));
  for (let index = 0; index < samples.length; index++) {
    const { service, input, records } = fixture(); input.onDelta = () => {};
    await assert.rejects(service.generate(input), error => {
      assert.equal(error.getStatus(), 502); assert.doesNotMatch(error.message, /UPSTREAM_SECRET_NOT_EXPOSED/); return true;
    });
    assert.ok(records.reservations[0].reservedTokens > 0n); assert.equal(records.usage[0].usageMeasured, false);
  }
});

test('token-limit completion records measured paid usage before rejecting partial text', async t => {
  const { service, input, records, quota } = fixture(); input.onDelta = () => {};
  await provider(t, (_body, response) => sse(response, [frame(chunk({ content: 'Parcial' })), frame(chunk({}, 'length')), frame({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 500 } }), frame('[DONE]')]));
  await assert.rejects(service.generate(input), /limite de tokens/);
  await quota.finish(input.quotaScope, 'FAILED');
  assert.equal(records.usage[0].inputTokens, 20); assert.equal(records.usage[0].outputTokens, 500);
  assert.equal(records.usage[0].usageMeasured, true); assert.equal(records.usage[0].status, 'FAILED'); assert.equal(records.reservations[0].reservedTokens, 0n);
});

test('abort stops real SSE immediately and leaves unknown consumption reserved', async t => {
  const { service, input, records } = fixture(); const controller = new AbortController(); let deltas = 0;
  input.signal = controller.signal; input.onDelta = () => { deltas++; controller.abort(new DOMException('disconnected', 'AbortError')); };
  await provider(t, (_body, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(frame(chunk({ content: 'Parcial' })));
    const timer = setTimeout(() => response.end(frame(chunk({}, 'stop')) + frame('[DONE]')), 1000);
    response.on('close', () => clearTimeout(timer));
  });
  await assert.rejects(service.generate(input), { name: 'AbortError' });
  assert.equal(deltas, 1); assert.equal(records.usage[0].usageMeasured, false); assert.ok(records.reservations[0].reservedTokens > 0n);
});

test('JSON tools convert Responses definitions, recheck tenant execution, replay tool messages and sum rounds', async t => {
  const functions = [localFunction()]; const { service, input, records } = fixture(functions);
  input.model.capabilities = { supportsTools: true };
  const local = await provider(t, (_body, response, round) => json(response, round === 1 ? completion(null, { finishReason: 'tool_calls', calls: [call()] }) : completion()));
  const result = await service.generate(input);
  assert.equal(result.answer, 'O orçamento é 42.'); assert.equal(result.inputTokens, 60); assert.equal(result.outputTokens, 20);
  assert.deepEqual(result.toolCalls, [{ callId: 'call-a', name: 'lookup_budget' }]);
  assert.deepEqual(records.executed, [{ callId: 'call-a', name: 'lookup_budget', arguments: '{"year":2026}' }]);
  assert.deepEqual(local.requests[0].body.tools, [{ type: 'function', function: { name: 'lookup_budget', description: 'Consulta orçamento', parameters: functions[0].definition.parameters, strict: false } }]);
  assert.deepEqual(local.requests[1].body.messages.at(-2), { role: 'assistant', content: null, tool_calls: [call()] });
  assert.deepEqual(local.requests[1].body.messages.at(-1), { role: 'tool', tool_call_id: 'call-a', content: '{"result":42}' });
  assert.equal(records.reservations.length, 2); assert.ok(records.reservations.every(row => row.reservedTokens === 0n));
});

test('streamed tool argument fragments are assembled before execution and replay', async t => {
  const { service, input, records } = fixture([localFunction()]); input.model.capabilities = { supportsTools: true }; input.onDelta = () => {};
  const local = await provider(t, (_body, response, round) => {
    if (round === 1) return sse(response, [
      frame(chunk({ tool_calls: [{ index: 0, id: 'call-stream', type: 'function', function: { name: 'lookup_budget', arguments: '{"year":' } }] })),
      frame(chunk({ tool_calls: [{ index: 0, function: { arguments: '2026}' } }] })),
      frame(chunk({}, 'tool_calls')), frame({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 5 } }), frame('[DONE]'),
    ]);
    return sse(response, [frame(chunk({ content: '42' })), frame(chunk({}, 'stop')), frame({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 1 } }), frame('[DONE]')]);
  });
  const result = await service.generate(input);
  assert.equal(result.answer, '42'); assert.equal(result.inputTokens, 90); assert.equal(result.outputTokens, 6);
  assert.equal(records.executed[0].arguments, '{"year":2026}'); assert.equal(local.requests[1].body.messages.at(-1).tool_call_id, 'call-stream');
});

test('unknown, duplicate and excessive function requests never execute unauthorized calls', async t => {
  let selected = 0;
  const samples = [
    completion(null, { finishReason: 'tool_calls', calls: [call('foreign', 'not_linked')] }),
    completion(null, { finishReason: 'tool_calls', calls: [call(), call()] }),
    completion(null, { finishReason: 'tool_calls', calls: Array.from({ length: 9 }, (_, index) => call('call-' + index)) }),
  ];
  await provider(t, (_body, response) => json(response, samples[selected++]));
  for (const _sample of samples) {
    const { service, input, records } = fixture([localFunction()]); input.model.capabilities = { supportsTools: true };
    await assert.rejects(service.generate(input), /ferramenta|identificador/);
    assert.equal(records.executed.length, 0);
  }
});

test('limits function loops to eight paid rounds and seven executed calls before a required final answer', async t => {
  const { service, input, records } = fixture([localFunction()]); input.model.capabilities = { supportsTools: true };
  const local = await provider(t, (_body, response, round) => json(response, completion(null, { finishReason: 'tool_calls', calls: [call('call-' + round)] })));
  await assert.rejects(service.generate(input), /oito chamadas\/rodadas/);
  assert.equal(local.requests.length, 8); assert.equal(records.executed.length, 7); assert.equal(records.reservations.length, 8);
});

test('provider failures are sanitized and explicit rejected requests release quota', async t => {
  let status = 401;
  await provider(t, (_body, response) => json(response, { error: { message: 'API_KEY_AND_PROMPT_MUST_NOT_LEAK' } }, status));
  for (const rejected of [400, 401, 403, 404, 422, 429]) {
    status = rejected;
    const { service, input, records } = fixture();
    await assert.rejects(service.generate(input), error => {
      assert.doesNotMatch(error.message, /API_KEY_AND_PROMPT_MUST_NOT_LEAK/); assert.equal(error.providerStatus, rejected); return true;
    });
    assert.equal(records.reservations[0].status, 'REJECTED'); assert.equal(records.reservations[0].reservedTokens, 0n);
  }
  status = 402;
  const insufficient = fixture(); await assert.rejects(insufficient.service.generate(insufficient.input), /saldo/);
  status = 503;
  const unavailable = fixture(); await assert.rejects(unavailable.service.generate(unavailable.input), /indisponível/);
});

test('missing consumption remains unmeasured; malformed consumption and incomplete JSON are rejected', async t => {
  let selected = 0;
  const samples = [completion('Resposta', { usage: false }), completion('Parcial', { finishReason: 'length' }), completion('Resposta', { usage: { prompt_tokens: -1, completion_tokens: 2 } })];
  await provider(t, (_body, response) => json(response, samples[selected++]));
  const first = fixture(); const result = await first.service.generate(first.input);
  assert.equal(result.measured, false); assert.equal(result.inputTokens, 0); assert.ok(first.records.reservations[0].reservedTokens > 0n);
  const second = fixture(); await assert.rejects(second.service.generate(second.input), /incompleta/); assert.equal(second.records.usage[0].usageMeasured, true);
  const third = fixture(); await assert.rejects(third.service.generate(third.input), /contadores/); assert.equal(third.records.usage[0].usageMeasured, false);
});

for (const streaming of [false, true]) {
  const format = streaming ? 'SSE' : 'JSON';
  async function usageProvider(t, samples) {
    let selected = 0;
    return provider(t, (_body, response) => {
      const usage = samples[selected++];
      return streaming
        ? sse(response, [frame(chunk({ content: 'Resposta' })), frame(chunk({}, 'stop')), frame({ choices: [], usage }), frame('[DONE]')])
        : json(response, completion('Resposta', { usage }));
    });
  }

  test(`${format} consumption preserves additional tokens in the gateway total without counting details twice`, async t => {
    const samples = [
      { prompt_tokens: 92, completion_tokens: 5, total_tokens: 154 },
      { prompt_tokens: 92, completion_tokens: 62, total_tokens: 154, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 57 } },
      { prompt_tokens: 92, completion_tokens: 5, total_tokens: 97 },
      { prompt_tokens: 92, completion_tokens: 5 },
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    ];
    const expected = [[92, 62], [92, 62], [92, 5], [92, 5], [0, 0]];
    await usageProvider(t, samples);
    for (const [index, sample] of samples.entries()) {
      const { service, input, records } = fixture(); if (streaming) input.onDelta = () => {};
      const result = await service.generate(input);
      assert.equal(result.inputTokens, expected[index][0]); assert.equal(result.outputTokens, expected[index][1]);
      assert.equal(result.measured, true); assert.equal(records.usage[0].usageMeasured, true);
      assert.equal(records.usage[0].inputTokens + records.usage[0].outputTokens, sample.total_tokens ?? 97);
      assert.equal(records.reservations[0].reservedTokens, 0n);
    }
  });

  test(`${format} a gateway total cannot infer a missing prompt or completion counter`, async t => {
    const samples = [
      { prompt_tokens: 92, total_tokens: 154 },
      { completion_tokens: 5, total_tokens: 154 },
      { prompt_tokens: null, completion_tokens: 5, total_tokens: 154 },
      { total_tokens: 154 },
    ];
    const expected = [[92, 0], [0, 5], [0, 5], [0, 0]];
    await usageProvider(t, samples);
    for (const [index] of samples.entries()) {
      const { service, input, records } = fixture(); if (streaming) input.onDelta = () => {};
      const result = await service.generate(input);
      assert.equal(result.inputTokens, expected[index][0]); assert.equal(result.outputTokens, expected[index][1]);
      assert.equal(result.measured, false); assert.equal(records.usage[0].usageMeasured, false);
      assert.ok(records.reservations[0].reservedTokens > 0n);
    }
  });

  test(`${format} invalid or contradictory gateway totals fail with unknown consumption reserved`, async t => {
    const samples = [96, null, -1, 97.5, '154', true, 2_147_483_648].map(total_tokens => ({ prompt_tokens: 92, completion_tokens: 5, total_tokens }));
    await usageProvider(t, samples);
    for (const _sample of samples) {
      const { service, input, records } = fixture(); if (streaming) input.onDelta = () => {};
      await assert.rejects(service.generate(input), error => {
        assert.equal(error.getStatus(), 502); assert.match(error.message, /contadores/); return true;
      });
      assert.equal(records.usage[0].usageMeasured, false); assert.ok(records.reservations[0].reservedTokens > 0n);
    }
  });
}

test('redirects are refused rather than forwarding a server API key', async t => {
  let redirected = 0;
  const target = http.createServer((_request, response) => { redirected++; json(response, completion()); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(async () => { target.closeAllConnections(); await new Promise(resolve => target.close(resolve)); });
  await provider(t, (_body, response) => { response.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/other` }); response.end(); });
  const { service, input } = fixture(); await assert.rejects(service.generate(input), /conexão/); assert.equal(redirected, 0);
});

test('DONE terminates an SSE request without waiting for a keep-alive connection to close', async t => {
  const { service, input } = fixture(); input.onDelta = () => {};
  await provider(t, (_body, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(frame(chunk({ content: 'Resposta completa' })) + frame(chunk({}, 'stop')) + frame('[DONE]'));
  });
  const controller = new AbortController(); input.signal = controller.signal;
  const timer = setTimeout(() => controller.abort(new DOMException('fixture did not stop after DONE', 'AbortError')), 1000);
  try { assert.equal((await service.generate(input)).answer, 'Resposta completa'); } finally { clearTimeout(timer); }
});

test('a real request timeout is sanitized and retains the unknown provider consumption budget', async t => {
  const savedTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => savedTimeout(30);
  t.after(() => { AbortSignal.timeout = savedTimeout; });
  const { service, input, records } = fixture();
  await provider(t, (_body, _response) => {});
  await assert.rejects(service.generate(input), /tempo limite/);
  assert.equal(records.usage[0].usageMeasured, false); assert.ok(records.reservations[0].reservedTokens > 0n);
});

test('vision requires a verified catalog context window before reserving quota or contacting the provider', async t => {
  const { service, input, records } = fixture();
  const local = await provider(t, (_body, response) => json(response, completion()));
  input.images = [{ name: 'foto.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,aGVsbG8=' }];
  for (const contextWindow of [undefined, 0, 4095, 4096.5, 2_000_001, '8192']) {
    input.model.capabilities = { supportsVision: true, contextWindow };
    await assert.rejects(service.generate(input), /janela de contexto válida em Modelos/);
  }
  assert.equal(local.requests.length, 0); assert.equal(records.reservations.length, 0);
});

test('a megabyte JPEG fits a 100k-token license by reserving the catalog window rather than base64 bytes', async t => {
  const { service, input, records, prisma } = fixture();
  prisma.license.findFirst = async () => ({ status: 'ACTIVE', startDate: new Date(Date.now() - 86400000), endDate: null, maxTokens: 100000n });
  input.model.capabilities = { supportsVision: true, contextWindow: 8192 };
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const canvas = createCanvas(1280, 1024); const context = canvas.getContext('2d'); const pixels = context.createImageData(1280, 1024);
  let random = 739;
  for (let index = 0; index < pixels.data.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; pixels.data[index + channel] = random >>> 24; }
    pixels.data[index + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  const jpeg = canvas.toBuffer('image/jpeg', 95);
  assert.ok(jpeg.length > 1024 * 1024); assert.equal((await loadImage(jpeg)).width, 1280);
  input.images = [{ name: 'foto.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64') }];
  const local = await provider(t, (_body, response) => json(response, completion()));
  const result = await service.generate(input);
  assert.equal(result.answer, 'O orçamento é 42.'); assert.equal(result.measured, true);
  assert.equal(local.requests.length, 1); assert.ok(Buffer.byteLength(JSON.stringify(local.requests[0].body)) > 1_000_000);
  assert.deepEqual(records.initialBudgets, [8192n]); assert.equal(records.reservations[0].reservedTokens, 0n);
  assert.equal(records.usage[0].inputTokens, 30); assert.equal(records.usage[0].outputTokens, 10);
});

test('tool definitions count against the context window before the first paid request', async t => {
  const fn = localFunction(); fn.definition.parameters.description = 'x'.repeat(5000);
  const { service, input, records } = fixture([fn]); input.model.capabilities = { supportsTools: true, contextWindow: 4096 };
  const local = await provider(t, (_body, response) => json(response, completion()));
  await assert.rejects(service.generate(input), /ferramentas excedem o contexto/);
  assert.equal(local.requests.length, 0); assert.equal(records.reservations.length, 0); assert.equal(records.executed.length, 0);
});

test('tool results are rechecked against the context window before the next paid request', async t => {
  const { service, input, records, runtime } = fixture([localFunction()]); input.model.capabilities = { supportsTools: true, contextWindow: 4096 };
  runtime.execute = async (_tenant, _agent, requested) => { records.executed.push(requested); return { callId: requested.callId, name: requested.name, output: 'x'.repeat(5000) }; };
  const local = await provider(t, (_body, response) => json(response, completion(null, { finishReason: 'tool_calls', calls: [call()] })));
  await assert.rejects(service.generate(input), /ferramentas excedem o contexto/);
  assert.equal(local.requests.length, 1); assert.equal(records.reservations.length, 1); assert.equal(records.executed.length, 1);
  assert.equal(records.usage[0].usageMeasured, true); assert.equal(records.usage[0].inputTokens, 30);
});

test('gateway reasons pick a clear message without exposing the provider text', async t => {
  let reason = 'litellm.AuthenticationError: OpenAIException - The api_key client option must be set';
  await provider(t, (_body, response) => json(response, { error: { message: reason } }, reason.includes('Invalid model') ? 400 : 401));
  const missing = fixture();
  await assert.rejects(missing.service.generate(missing.input), error => { assert.match(error.message, /Chaves dos provedores de IA/); assert.doesNotMatch(error.message, /OpenAIException/); return true; });
  reason = '/chat/completions: Invalid model name passed in model=openai/x';
  const unknown = fixture();
  await assert.rejects(unknown.service.generate(unknown.input), /não está disponível no gateway/);
});

test('the prefeitura key from SGDM goes only on the wire, for models of its provider', async t => {
  const { requests } = await provider(t, (_body, response) => json(response, completion()));
  const { input, records, quota, runtime } = fixture();
  const asked = [];
  const tenantKeys = { forModel: async (tenantId, slug) => { asked.push([tenantId, slug]); return 'sk-prefeitura-123'; } };
  const service = new OmniRouterService(runtime, quota, tenantKeys);
  await service.generate(input);
  assert.deepEqual(asked, [['tenant-a', 'openai/model-from-catalog']]);
  assert.equal(requests[0].body.api_key, 'sk-prefeitura-123');
  assert.ok(!JSON.stringify(records, (_key, value) => typeof value === 'bigint' ? String(value) : value).includes('sk-prefeitura-123'));
  const without = new OmniRouterService(runtime, quota, { forModel: async () => undefined });
  await without.generate(input);
  assert.equal('api_key' in requests[1].body, false);
});

test('LiteLLM stream shape: an empty usage frame after the finish is accepted; text after it is not', async t => {
  let trailing = {};
  await provider(t, (_body, response) => sse(response, [
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content: 'o' } }] }),
    frame({ choices: [{ index: 0, delta: { content: 'k' } }] }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    frame({ choices: [{ index: 0, delta: trailing }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }),
    frame('[DONE]'),
  ]));
  const ok = fixture(); const deltas = []; ok.input.onDelta = text => deltas.push(text);
  const result = await ok.service.generate(ok.input);
  assert.equal(result.answer, 'ok'); assert.equal(result.inputTokens, 9); assert.equal(result.measured, true);
  trailing = { content: 'extra' };
  const bad = fixture(); bad.input.onDelta = () => {};
  await assert.rejects(bad.service.generate(bad.input), /após concluir/);
});

test('cada chamada leva user = prefeitura e as tags de usuário, origem e conversa', async t => {
  const { requests } = await provider(t, (_b, r) => json(r, completion()));
  const { service, input } = fixture();
  input.origin = 'i7ai-chat'; input.conversationId = 'conv-1';
  await service.generate(input);
  assert.equal(requests[0].body.user, 'tenant-a');
  assert.deepEqual(requests[0].body.metadata.tags.sort(), ['conversa:conv-1', 'origem:i7ai-chat', 'usuario:user-a']);
  const auto = fixture(); auto.input.origin = 'i7ai-automacao'; delete auto.input.userId; delete auto.input.conversationId;
  await auto.service.generate(auto.input);
  assert.deepEqual(requests[1].body.metadata.tags, ['origem:i7ai-automacao']);
});
