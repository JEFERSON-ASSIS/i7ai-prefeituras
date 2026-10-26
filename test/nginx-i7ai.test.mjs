import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const image = 'i7ai-frontend-test';

test('frontend serve sob /i7ai e repassa /i7ai/api ao backend', async (t) => {
  execSync(`docker build -t ${image} .`, { stdio: 'inherit' });
  const id = execSync(`docker run -d --rm -p 127.0.0.1:18080:8080 ${image}`).toString().trim();
  t.after(() => execSync(`docker rm -f ${id}`));
  await new Promise((r) => setTimeout(r, 1500));
  const base = 'http://127.0.0.1:18080';
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const index = await fetch(`${base}/i7ai/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /src="\/i7ai\/assets\//);
  assert.equal((await fetch(`${base}/i7ai/qualquer/rota`)).status, 200);
  // No backend container exists in this test, so the proxy must answer 502.
  assert.equal((await fetch(`${base}/i7ai/api/health`)).status, 502);
  assert.equal((await fetch(`${base}/`)).status, 404);
});
