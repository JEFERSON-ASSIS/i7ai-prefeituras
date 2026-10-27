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
    'SGDMNET', 'litellm', 'start-first',
    'i7ai-postgres', 'i7ai-redis',
    'i7ai-backend', 'i7ai-frontend', 'traefik.http.routers.i7ai_plataforma.rule: Host(`sgdm.com.br`) && (Path(`/i7ai`) || PathPrefix(`/i7ai/`))',
    'traefik.docker.network: SGDMNET', 'name: i7ai_litellm_config_v2',
    'ghcr.io/berriai/litellm@sha256:c169fb3adc514fcf210377c203f3de406d54f10bfdacf13948a4a839db9af7de',
    'OMNIROUTER_BASE_URL: http://litellm:4000/v1', 'SGDM_API_URL: http://sgdm-api:3001/api/v1',
    '@i7ai-postgres:5432/i7ai', '@i7ai-postgres:5432/litellm', 'S3_ENDPOINT: http://minio:9000',
    'S3_ACCESS_KEY: i7ai-app', 'S3_BUCKET: i7ai-documents',
  ]) assert.ok(out.includes(expected), `missing ${expected}`);
  // Depending on the CLI version, 1200M renders as-is or in bytes.
  assert.match(out, /memory: "?(1200M|1258291200)"?/);
  assert.ok(!out.includes('published:'), 'no port may be published');
  assert.ok(!out.includes('traefik.swarm.network'), 'traefik.swarm.network was removed on purpose (2f64e12)');
  assert.ok(!out.includes('i7ai_litellm_config_v1'), 'the changed LiteLLM config needs a new immutable Swarm config name');
  // read_only services need /tmp as a tmpfs mount that Swarm honours (long volume syntax).
  for (const service of ['i7ai-backend', 'i7ai-frontend']) {
    const block = out.split(new RegExp(`^  ${service}:$`, 'm'))[1]?.split(/^  \S/m)[0] ?? '';
    assert.match(block, /type: tmpfs\s+target: \/tmp/, `${service} must mount /tmp as tmpfs`);
    assert.doesNotMatch(block, /^    tmpfs:/m, `${service} must not rely on short tmpfs syntax`);
    assert.doesNotMatch(block, /type: volume\s+target: \/tmp/, `${service} must not mount /tmp as a volume`);
  }
  // The marketing site's router and the shared names on SGDMNET must stay untouched.
  assert.ok(!/routers\.i7ai\./.test(out), 'router name must not collide with the marketing site');
  assert.ok(!/@postgres:|redis:\/\/[^@]*@redis:/.test(out), 'must not target SGDM postgres/redis');
  // Storage is the SGDM's shared MinIO; the stack must not ship a MinIO of its own.
  assert.ok(out.includes('http://minio:9000'), 'storage must be the shared minio:9000');
  assert.ok(!/^  i7ai-minio:$/m.test(out), 'no i7ai-minio service');
  assert.ok(!/quay\.io\/minio|minio\/minio|i7ai_minio|MINIO_ROOT/.test(out), 'no MinIO image, volume or root credentials');
});

test('variável obrigatória ausente derruba a renderização', () => {
  for (const name of ['LITELLM_SALT_KEY', 'I7AI_S3_ACCESS_KEY', 'I7AI_S3_SECRET_KEY']) {
    const result = renderStack({ [name]: undefined });
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, new RegExp(name));
  }
});

test('o exemplo de variáveis não traz credenciais raiz do MinIO', () => {
  const vars = exampleEnv();
  assert.ok(!Object.keys(vars).some((key) => key.startsWith('MINIO_ROOT')));
  assert.ok('I7AI_S3_ACCESS_KEY' in vars && 'I7AI_S3_SECRET_KEY' in vars);
  assert.match(vars.I7AI_S3_SECRET_KEY, /^change-/);
});
