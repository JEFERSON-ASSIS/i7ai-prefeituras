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
