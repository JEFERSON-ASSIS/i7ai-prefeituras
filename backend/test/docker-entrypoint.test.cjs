const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const entrypoint = path.join(__dirname, '..', 'docker-entrypoint.sh');

// Runs the entrypoint with a stub `node` that logs its arguments and exits
// with the code in STUB_EXIT_<n> (n = call number, starting at 1).
// The stub dir is passed via env so no Windows backslashes end up in the script.
function run(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-'));
  const stub = path.join(dir, 'node');
  fs.writeFileSync(stub, [
    '#!/bin/sh',
    'n=$(( $(cat "$STUB_DIR/counter" 2>/dev/null || echo 0) + 1 ))',
    'echo $n > "$STUB_DIR/counter"',
    'echo "$*" >> "$STUB_DIR/calls.log"',
    'eval "exit \\${STUB_EXIT_$n:-0}"',
    '',
  ].join('\n'), { mode: 0o755 });
  const baseEnv = { ...process.env };
  delete baseEnv.RUN_MIGRATIONS;
  const result = spawnSync('sh', [entrypoint, 'node', 'dist/main.js'], {
    env: { ...baseEnv, STUB_DIR: dir.replace(/\\/g, '/'), ...env, PATH: dir + path.delimiter + process.env.PATH },
    encoding: 'utf8',
  });
  const log = path.join(dir, 'calls.log');
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, calls, stderr: result.stderr };
}

test('roda migrate deploy, bucket e o comando, nesta ordem', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, ['node_modules/prisma/build/index.js migrate deploy', 'scripts/ensure-bucket.cjs', 'dist/main.js']);
});

test('RUN_MIGRATIONS=false pula migrations e bucket', () => {
  const r = run({ RUN_MIGRATIONS: 'false' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, ['dist/main.js']);
});

test('falha na migration aborta sem iniciar a API', () => {
  const r = run({ STUB_EXIT_1: '1' });
  assert.equal(r.status, 1);
  assert.ok(!r.calls.includes('dist/main.js'));
});

test('falha no bucket aborta sem iniciar a API', () => {
  const r = run({ STUB_EXIT_2: '1' });
  assert.equal(r.status, 1);
  assert.ok(!r.calls.includes('dist/main.js'));
});
