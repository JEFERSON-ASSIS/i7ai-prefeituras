const test = require('node:test');
const assert = require('node:assert/strict');
const { requestJson, isTransientNetworkError } = require('../dist/research/research-text');

const reset = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
const ok = (body = '{"a":1}') => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

test('a dropped connection is retried until an attempt succeeds', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; if (calls < 3) throw reset(); return ok(); };
  const result = await requestJson(fetchFn, 'https://pncp.gov.br/x', { method: 'GET' });
  assert.equal(calls, 3);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { a: 1 });
});

test('four dropped connections give up with the network error', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; throw reset(); };
  await assert.rejects(requestJson(fetchFn, 'https://pncp.gov.br/x', { method: 'GET' }), (e) => isTransientNetworkError(e));
  assert.equal(calls, 4);
});

test('a 503 is retried; a 404 is not', async () => {
  let calls = 0;
  const flaky = async () => { calls++; return calls === 1 ? new Response('', { status: 503 }) : ok(); };
  assert.equal((await requestJson(flaky, 'https://pncp.gov.br/x', {})).ok, true);
  assert.equal(calls, 2);
  calls = 0;
  const missing = async () => { calls++; return new Response('', { status: 404 }); };
  assert.equal((await requestJson(missing, 'https://pncp.gov.br/x', {})).status, 404);
  assert.equal(calls, 1);
});

test('other errors (redirect, abort) are not retried', async () => {
  let calls = 0;
  const redirect = async () => { calls++; throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); };
  await assert.rejects(requestJson(redirect, 'https://pncp.gov.br/x', {}));
  assert.equal(calls, 1);
});
