import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const stackFile = 'portainer/i7ai.stack.yml';

// Parse portainer/stack.env.example (KEY=value lines; comments and blanks ignored).
function exampleEnv() {
  const vars = {};
  for (const line of readFileSync('portainer/stack.env.example', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

function renderStack(overrides = {}) {
  const env = { ...process.env, ...exampleEnv(), ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return spawnSync('docker', ['stack', 'config', '-c', stackFile], { env, encoding: 'utf8' });
}

test('a pilha renderiza com o exemplo e não publica portas', () => {
  const result = renderStack();
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  for (const expected of [
    'SGDMNET', 'litellm', 'start-first', 'memory: "1258291200"', // docker stack config renders 1200M as bytes
    'i7ai-postgres', 'i7ai-redis', 'i7ai-minio',
    'i7ai-backend', 'i7ai-frontend', 'traefik.http.routers.i7ai_plataforma.rule: Host(`sgdm.com.br`) && PathPrefix(`/i7ai`)',
    'traefik.swarm.network: SGDMNET', 'traefik.docker.network: SGDMNET',
    'ghcr.io/berriai/litellm@sha256:c169fb3adc514fcf210377c203f3de406d54f10bfdacf13948a4a839db9af7de',
    'OMNIROUTER_BASE_URL: http://litellm:4000/v1', 'SGDM_API_URL: http://sgdm-api:3001/api/v1',
    '@i7ai-postgres:5432/i7ai', '@i7ai-postgres:5432/litellm', 'S3_ENDPOINT: http://i7ai-minio:9000',
  ]) assert.ok(out.includes(expected), `missing ${expected}`);
  assert.ok(!out.includes('published:'), 'no port may be published');
  // The marketing site's router and the shared names on SGDMNET must stay untouched.
  assert.ok(!/routers\.i7ai\./.test(out), 'router name must not collide with the marketing site');
  assert.ok(!/@postgres:|redis:\/\/[^@]*@redis:|http:\/\/minio:/.test(out), 'must not target SGDM data services');
});

test('variável obrigatória ausente derruba a renderização', () => {
  const result = renderStack({ LITELLM_SALT_KEY: undefined });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LITELLM_SALT_KEY/);
});
