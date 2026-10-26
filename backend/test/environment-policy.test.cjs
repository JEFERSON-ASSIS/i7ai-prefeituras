const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const path = require('node:path');

const module_ = path.resolve(__dirname, '../dist/config/environment.js');
const good = 'a'.repeat(32);
const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://x:y@db:5432/z', REDIS_URL: 'redis://r:6379', S3_ENDPOINT: 'http://s3:9000' };

// Runs in a child process from an empty cwd so no local .env leaks in.
function load(extra) {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...base, ...extra };
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(module_)})`], { cwd: tmpdir(), env, encoding: 'utf8' });
}

test('production accepts strong secrets', () => {
  assert.equal(load({ JWT_SECRET: good, SGDM_JWT_SECRET: good + 'b' }).status, 0);
  assert.equal(load({ SGDM_JWT_SECRET: good }).status, 0);
});

test('production rejects placeholder and short secrets', () => {
  for (const bad of ['change-copie-o-JWT_SECRET-da-stack-sgdm-app', 'local-development-' + good, 'TROQUE_' + good, 'Copie-' + good, 'short']) {
    assert.notEqual(load({ SGDM_JWT_SECRET: bad }).status, 0, bad);
    assert.notEqual(load({ JWT_SECRET: bad }).status, 0, bad);
  }
});

test('production validates both secrets when both are set', () => {
  const placeholder = 'change-copie-o-JWT_SECRET-da-stack-sgdm-app';
  assert.notEqual(load({ SGDM_JWT_SECRET: good, JWT_SECRET: placeholder }).status, 0);
  assert.notEqual(load({ SGDM_JWT_SECRET: placeholder, JWT_SECRET: good }).status, 0);
  assert.notEqual(load({}).status, 0);
});

test('non-production does not enforce the policy', () => {
  assert.equal(load({ NODE_ENV: 'development', JWT_SECRET: 'x' }).status, 0);
});
