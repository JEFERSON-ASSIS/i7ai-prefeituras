import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, auditDetail } from '../src/features/central-format.mjs';

test('an invalid or missing date shows a dash', () => {
  for (const value of ['abc', undefined, null, '']) assert.equal(formatDate(value), '—');
  assert.notEqual(formatDate('2026-10-27T12:00:00Z'), '—');
});

test('platform views show the reason and the conversation id as text; other events show nothing', () => {
  const item = { event: 'conversation.viewed_by_platform', resourceId: 'c-1', metadata: { motivo: 'Chamado <b>123</b> do cidadão' } };
  assert.equal(auditDetail(item), 'Motivo: Chamado <b>123</b> do cidadão · Conversa: c-1');
  assert.equal(auditDetail({ event: 'conversation.viewed_by_platform', resourceId: 'c-1' }), 'Conversa: c-1');
  assert.equal(auditDetail({ event: 'user.login', metadata: { motivo: 'x' } }), '');
});

import { auditEventLabel, auditResourceLabel } from '../src/features/central-format.mjs';

test('audit events and resources show in Portuguese, unknown ones keep the code', () => {
  assert.equal(auditEventLabel('agent.chat_completed'), 'Conversa respondida');
  assert.equal(auditEventLabel('chat_attachment.uploaded'), 'Arquivo anexado no chat');
  assert.equal(auditEventLabel('tenant.provisioned'), 'Prefeitura ativada na IA do SGDM');
  assert.equal(auditEventLabel('algo.novo'), 'algo.novo');
  assert.equal(auditEventLabel(undefined), '—');
  assert.equal(auditResourceLabel('agents'), 'Agente');
  assert.equal(auditResourceLabel('tenants'), 'Prefeitura');
  assert.equal(auditResourceLabel(null), '—');
});
