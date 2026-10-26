const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../..');

test('a plataforma local carrega a sessão antes do host real', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'preview/local.html'), 'utf8');
  const sessionPosition = html.indexOf('/output/preview-server/session.js');
  const hostPosition = html.indexOf('/preview/local.jsx');

  assert.ok(sessionPosition >= 0, 'A página local deve carregar a sessão gerada.');
  assert.ok(hostPosition > sessionPosition, 'A sessão precisa existir antes do host React.');
});

test('a sessão local serializa o contexto sem incluir o segredo de assinatura', () => {
  const { serializeContext } = require('../scripts/create-local-session.cjs');
  const script = serializeContext({
    accessToken: 'jwt-temporario',
    tenantName: 'Prefeitura </script><script>alert(1)</script>',
    organizationName: 'SGDM',
    modulePage: 'dashboard',
    navigationManagedByHost: true,
    signingSecret: 'nao-pode-sair',
  });

  assert.match(script, /^window\.__SGDM_CONTEXT__ = /);
  assert.match(script, /jwt-temporario/);
  assert.doesNotMatch(script, /nao-pode-sair/);
  assert.doesNotMatch(script, /<\/script>/i);
});

test('a criação de sessão local é recusada em produção', () => {
  const { assertDevelopment } = require('../scripts/create-local-session.cjs');
  assert.throws(() => assertDevelopment('production'), /somente no desenvolvimento/);
  assert.doesNotThrow(() => assertDevelopment('development'));
});
