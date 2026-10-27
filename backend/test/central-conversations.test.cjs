const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { ValidationPipe, Logger, ForbiddenException } = require('@nestjs/common');
const { CentralConversationsService } = require('../dist/central/central-conversations.service');
const { CentralConversationsController } = require('../dist/central/central-conversations.controller');
const { OpenConversationDto } = require('../dist/central/dto/open-conversation.dto');
const { PermissionsGuard } = require('../dist/auth/permissions.guard');
const { PERMISSION_KEY } = require('../dist/auth/permissions.decorator');
const { ConversationsController } = require('../dist/ai/conversations.controller');
const { Reflector } = require('@nestjs/core');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const VIEWER = { sub: '44444444-4444-4444-8444-444444444444', tenantId: A, email: 'dono@plataforma.gov.br', name: 'Dono', roles: [], permissions: [], centralIa: true };
const MOTIVO = 'Chamado 123 do suporte sobre resposta incorreta';
const SECRET_CONTENT = 'conteudo-sigiloso-da-conversa';

const message = (n, extra = {}) => ({ id: 'm' + n, role: n % 2 ? 'user' : 'assistant', content: SECRET_CONTENT + n, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)), attachments: [], ...extra });

function fixture({ messages = [message(1), message(2)], exists = true, auditFails = false } = {}) {
  const calls = { reads: 0, audits: [], updates: 0 };
  const row = () => ({
    id: CONVERSATION, tenantId: B, title: 'Titulo original', createdAt: new Date(Date.UTC(2026, 0, 1)),
    tenant: { name: 'Prefeitura B' }, agent: { name: 'Agente' }, model: { slug: 'modelo-x' },
    // The service asks for the newest first, capped by `take`.
    messages: [...messages].sort((a, b) => b.createdAt - a.createdAt).slice(0, 1001),
  });
  const tx = {
    conversation: { findUnique: async () => { calls.reads++; return exists ? row() : null; }, update: async () => { calls.updates++; }, updateMany: async () => { calls.updates++; } },
    message: { create: async () => { calls.updates++; } },
    auditLog: { create: async ({ data }) => { if (auditFails) throw new Error('audit down'); calls.audits.push(data); return data; } },
  };
  const prisma = { $transaction: async fn => { const staged = calls.audits.length; try { return await fn(tx); } catch (error) { calls.audits.length = staged; throw error; } } };
  return { service: new CentralConversationsService(prisma), calls };
}

function captureLogs(t) {
  const lines = [];
  const originals = {};
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose']) {
    originals[level] = Logger.prototype[level];
    Logger.prototype[level] = function (...args) { lines.push(args.join(' ')); };
  }
  t.after(() => { for (const level of Object.keys(originals)) Logger.prototype[level] = originals[level]; });
  return lines;
}

test('a viewer without IA_CENTRAL gets the same 403 for an existing and a missing conversation, with no database read', async () => {
  for (const exists of [true, false]) {
    const { service, calls } = fixture({ exists });
    await assert.rejects(service.open({ ...VIEWER, centralIa: false }, CONVERSATION, MOTIVO), error => error instanceof ForbiddenException && error.message === 'Acesso restrito à Central de IA.');
    assert.equal(calls.reads, 0);
    assert.equal(calls.audits.length, 0);
  }
  const { service } = fixture();
  await assert.rejects(service.open(undefined, CONVERSATION, MOTIVO), /Acesso restrito/);
});

test('the reason is validated by the DTO: 10 to 300 characters after trimming', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const validate = body => pipe.transform(body, { type: 'body', metatype: OpenConversationDto });
  await assert.rejects(validate({ motivo: 'curto' }), error => JSON.stringify(error.getResponse()).includes('Informe o motivo da abertura (10 a 300 caracteres).'));
  await assert.rejects(validate({ motivo: '   curto     ' }), /Bad Request/);
  await assert.rejects(validate({ motivo: 'x'.repeat(301) }), /Bad Request/);
  await assert.rejects(validate({}), /Bad Request/);
  assert.equal((await validate({ motivo: '  ' + MOTIVO + '  ' })).motivo, MOTIVO);
});

test('a missing conversation answers 404 and writes no audit', async () => {
  const { service, calls } = fixture({ exists: false });
  await assert.rejects(service.open(VIEWER, CONVERSATION, MOTIVO), error => error.status === 404 && error.message === 'Conversa não encontrada.');
  assert.equal(calls.audits.length, 0);
});

test('a platform viewer opens another prefeitura conversation in chronological order, audited in that prefeitura', async t => {
  const logs = captureLogs(t);
  const { service, calls } = fixture({ messages: [message(1), message(2, { attachments: [{ document: { name: 'oficio.pdf' } }] }), message(3)] });
  const view = await service.open(VIEWER, CONVERSATION, MOTIVO, '203.0.113.7');
  assert.deepEqual(view.mensagens.map(item => item.id), ['m1', 'm2', 'm3']);
  assert.deepEqual(view.mensagens[1].anexos, ['oficio.pdf']);
  assert.equal(view.prefeitura, 'Prefeitura B');
  assert.equal(view.agente, 'Agente');
  assert.equal(view.modelo, 'modelo-x');
  assert.equal(view.titulo, 'Titulo original');
  assert.equal(view.truncada, false);
  assert.equal(calls.audits.length, 1);
  const audit = calls.audits[0];
  assert.equal(audit.tenantId, B);
  assert.equal(audit.userId, VIEWER.sub);
  assert.equal(audit.event, 'conversation.viewed_by_platform');
  assert.equal(audit.resource, 'conversations');
  assert.equal(audit.resourceId, CONVERSATION);
  assert.equal(audit.ipAddress, '203.0.113.7');
  assert.deepEqual(audit.metadata, { viewerTenantId: A, viewerEmail: VIEWER.email, motivo: MOTIVO, origem: 'central-ia', mensagens: 3 });
  assert.equal(calls.updates, 0);
  const output = logs.join('\n');
  assert.ok(logs.length > 0);
  assert.ok(!output.includes(MOTIVO) && !output.includes(SECRET_CONTENT) && !output.includes('Titulo original'));
});

test('when the audit cannot be written nothing is returned', async () => {
  const { service, calls } = fixture({ auditFails: true });
  await assert.rejects(service.open(VIEWER, CONVERSATION, MOTIVO), /audit down/);
  assert.equal(calls.audits.length, 0);
});

test('more than 1000 messages return the newest 1000, still chronological, flagged as truncated', async () => {
  const messages = Array.from({ length: 1005 }, (_, index) => message(index + 1));
  const { service, calls } = fixture({ messages });
  const view = await service.open(VIEWER, CONVERSATION, MOTIVO);
  assert.equal(view.mensagens.length, 1000);
  assert.equal(view.truncada, true);
  assert.equal(view.mensagens[0].id, 'm6');
  assert.equal(view.mensagens.at(-1).id, 'm1005');
  assert.equal(calls.audits[0].metadata.mensagens, 1000);
});

test('the route sets no-store, has no role permission, and a roleless viewer is still refused by role-guarded routes', async () => {
  assert.equal(Reflect.getMetadata('__headers__', CentralConversationsController.prototype.open).find(item => item.name === 'Cache-Control').value, 'no-store');
  assert.equal(Reflect.getMetadata(PERMISSION_KEY, CentralConversationsController.prototype.open), undefined);
  // A user with only IA_CENTRAL has no roles, so no permissions: role-guarded routes still answer 403.
  const roleless = { ...VIEWER, permissions: [] };
  const auth = { canActivate: async () => true };
  const guard = new PermissionsGuard(new Reflector(), auth);
  const context = { getHandler: () => ConversationsController.prototype.list, getClass: () => ConversationsController, switchToHttp: () => ({ getRequest: () => ({ user: roleless }) }) };
  await assert.rejects(guard.canActivate(context), /não possui permissão/);
});
