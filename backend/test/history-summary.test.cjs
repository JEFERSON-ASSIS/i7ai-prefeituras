const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateTokens, criticalItems, missingItems, planSummary, chooseSummaryModel, SUMMARY_PROMPT, SUMMARY_MAX_TOKENS } = require('../dist/ai/history-summary');

test('estimateTokens usa bytes UTF-8 / 4, arredondado para cima', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('çç'), 1);
});

test('criticalItems acha artigo, lei, valor, data e processo, normalizados', () => {
  const items = criticalItems('Conforme art. 75, II da Lei nº 14.133/2021, até R$ 59.906,02 em 15/03/2026; processo 2026.0001234-5');
  for (const expected of ['art. 75', 'lei nº 14.133/2021', 'r$ 59.906,02', '15/03/2026', '2026.0001234-5']) assert.ok(items.includes(expected), expected + ' em ' + JSON.stringify(items));
  assert.equal(new Set(items).size, items.length);
});

test('criticalItems: CPF, CNPJ, percentual, §, inciso, decreto, números longos; ponto final não entra', () => {
  const items = criticalItems('CPF 123.456.789-09, CNPJ 12.345.678/0001-90, reajuste de 12,5 % pelo §  2 e inciso IV do Decreto nº 10.024/2019 e Lei 8.666. Total 15000.');
  for (const expected of ['123.456.789-09', '12.345.678/0001-90', '12,5 %', '§ 2', 'inciso iv', 'decreto nº 10.024/2019', 'lei 8.666', '15000']) assert.ok(items.includes(expected), expected + ' em ' + JSON.stringify(items));
  assert.ok(!items.some(item => item.endsWith('.')));
  assert.deepEqual(criticalItems('§ 2 e §2 e § 2'), ['§ 2']);
  assert.deepEqual(criticalItems('Conversa sem nada jurídico, só o inciso civil e arte 3.'), []);
});

test('missingItems aponta só o que falta (espaços e maiúsculas não importam)', () => {
  const source = 'Art. 75 da Lei nº 14.133/2021, R$ 59.906,02 em 15/03/2026.';
  assert.deepEqual(missingItems(source, 'Dispensa pelo ART.  75, lei nº 14.133/2021, valor R$59.906,02 em 15/03/2026.'), []);
  assert.deepEqual(missingItems(source, 'Dispensa pelo art. 75 da Lei nº 14.133/2021 no valor de R$ 59.906,02.'), ['15/03/2026']);
});

test('missingItems não se engana com prefixos: item perdido dentro de um item maior do resumo continua faltando', () => {
  assert.deepEqual(missingItems('art. 7 e art. 75', 'Cita o art. 75.'), ['art. 7']);
  assert.deepEqual(missingItems('Prazos 01/03/2026 e 11/03/2026', 'Prazo 11/03/2026.'), ['01/03/2026']);
  assert.deepEqual(missingItems('Lei 8.66 e Lei 8.666', 'Só a Lei 8.666.'), ['lei 8.66']);
  assert.deepEqual(missingItems('R$ 1.000 e R$ 1.000,50', 'Valor de R$ 1.000,50.'), ['r$ 1.000']);
  assert.deepEqual(missingItems('inciso IV', 'inciso IVX'), ['inciso iv']);
  // Items inside a longer one at the same place are not separate items (the process number carries its year).
  assert.deepEqual(criticalItems('processo 2026.0001234-5'), ['2026.0001234-5']);
  assert.deepEqual(missingItems('processo 2026.0001234-5 e o ano 2026', 'Processo 2026.0001234-5.'), ['2026']);
});

const messages = count => Array.from({ length: count }, (_, index) => ({ id: 'm' + (index + 1), role: index % 2 ? 'assistant' : 'user', content: 'Mensagem ' + (index + 1), createdAt: new Date(1_000 + index) }));

test('planSummary resume em lotes, mantendo as keep mais recentes', () => {
  const first = planSummary(messages(22), null, 10);
  assert.deepEqual(first.toSummarize.map(item => item.id), messages(12).map(item => item.id));
  assert.equal(first.throughId, 'm12');
  assert.equal(planSummary(messages(15), null, 10), null);
  assert.equal(planSummary(messages(30), 'm12', 10), null);
  const next = planSummary(messages(34), 'm12', 10);
  assert.deepEqual(next.toSummarize.map(item => item.id), Array.from({ length: 12 }, (_, index) => 'm' + (index + 13)));
  assert.equal(next.throughId, 'm24');
  // Unordered input is ordered by createdAt; an unknown throughId summarizes from the start.
  assert.equal(planSummary([...messages(22)].reverse(), null, 10).throughId, 'm12');
  assert.equal(planSummary(messages(22), 'desconhecida', 10).throughId, 'm12');
});

test('chooseSummaryModel: barato do mesmo provedor se ativo e liberado; senão o da conversa; nunca outro provedor', () => {
  const modelos = { openai: 'openai/gpt-4o-mini', anthropic: 'anthropic/claude-haiku-5-5', gemini: null };
  const active = ['openai/gpt-4o-mini', 'anthropic/claude-haiku-5-5', 'anthropic/claude-sonnet-5-5', 'gemini/gemini-3-pro'];
  assert.equal(chooseSummaryModel('anthropic/claude-sonnet-5-5', modelos, active, null), 'anthropic/claude-haiku-5-5');
  assert.equal(chooseSummaryModel('anthropic/claude-sonnet-5-5', modelos, active, ['anthropic/claude-sonnet-5-5']), 'anthropic/claude-sonnet-5-5');
  assert.equal(chooseSummaryModel('anthropic/claude-sonnet-5-5', { ...modelos, anthropic: null }, active, null), 'anthropic/claude-sonnet-5-5');
  assert.equal(chooseSummaryModel('anthropic/claude-sonnet-5-5', { ...modelos, anthropic: 'openai/gpt-4o-mini' }, active, null), 'anthropic/claude-sonnet-5-5');
  assert.equal(chooseSummaryModel('gemini/gemini-3-pro', modelos, active, null), 'gemini/gemini-3-pro');
  assert.equal(chooseSummaryModel('anthropic/claude-sonnet-5-5', modelos, ['openai/gpt-4o-mini'], null), null);
  assert.equal(chooseSummaryModel('openai/gpt-5-5', modelos, ['openai/gpt-5-5'], null), 'openai/gpt-5-5');
});

test('SUMMARY_PROMPT e SUMMARY_MAX_TOKENS', () => {
  assert.equal(SUMMARY_MAX_TOKENS, 1500);
  for (const word of [/em ordem/i, /literalmente/i, /n[aã]o opine/i, /resumo anterior/i, /somente com o resumo|apenas com o resumo|só com o resumo/i]) assert.match(SUMMARY_PROMPT, word);
});
