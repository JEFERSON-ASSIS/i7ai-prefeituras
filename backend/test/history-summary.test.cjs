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
  // The summary may state a number inside a longer one (the year is still literally there).
  assert.deepEqual(missingItems('processo 2026.0001234-5 e o ano 2026', 'Processo 2026.0001234-5.'), []);
});

// Each row: source, a summary that keeps the item (other spelling when equivalent), a summary that swaps it.
const LEGAL_CASES = [
  ['Conforme o artigo 75.', 'Cita o art. 75.', 'Cita o artigo 57.'],
  ['Conforme art 75.', 'Artigo 75 citado.', 'Art 76 citado.'],
  ['Vide arts. 74 e 75.', 'Artigos 74 e 75.', 'Arts. 74 e 76.'],
  ['Nos termos do § 2º.', 'Pelo §2º.', 'Pelo § 3º.'],
  ['Parágrafo único do art. 5.', 'art. 5, § único.', 'art. 5, § 1º.'],
  ['Com base no inciso IV.', 'inciso IV aplicado.', 'inciso VI aplicado.'],
  ['Art. 75, II da lei.', 'art. 75, inciso II.', 'art. 75, inciso III.'],
  ['Prazo de 30 dias.', 'prazo: 30 dias.', 'prazo de 20 dias.'],
  ['Prazo de 30 dias úteis.', 'prazo: 30 dias úteis.', 'prazo de 30 dias corridos.'],
  ['Prazo de 30 dias corridos.', 'prazo de 30 dias corridos.', 'prazo de 30 dias úteis.'],
  ['Prazo de 30 dias.', 'prazo de 30 dias.', 'prazo de 30 dias úteis.'],
  ['Por 10 dias consecutivos.', 'por 10 dias seguidos.', 'por 10 dias.'],
  ['Lei Municipal 1.234/2020.', 'Lei Municipal nº 1.234/2020.', 'Lei Estadual 1.234/2020.'],
  ['Lei Federal 14.133/2021.', 'Lei Federal nº 14.133/2021.', 'Lei 14.133/2021.'],
  ['Lei Complementar 101/2000.', 'LC 101/2000.', 'Lei 101/2000.'],
  ['Vigência de 12 meses.', 'vigência 12 meses.', 'vigência 12 anos.'],
  ['Garantia de 5 anos.', 'garantia de 5 anos.', 'garantia de 3 anos.'],
  ['Multa de 500 reais.', 'multa de 500 reais.', 'multa de 50 reais.'],
  ['Resposta em 48 horas.', 'resposta em 48 horas.', 'resposta em 24 horas.'],
  ['Reajuste de 10%.', 'reajuste de 10 %.', 'reajuste de 1%.'],
  ['Juros de 12,5 por cento.', 'juros de 12,5%.', 'juros de 12%.'],
  ['O 1º colocado vence.', 'o 1º colocado.', 'o 2º colocado.'],
  ['Até 15 de março de 2026.', 'até 15/03/2026.', 'até 15 de maio de 2026.'],
  ['Até 15/03/2026.', 'até 15 de março de 2026.', 'até 16/03/2026.'],
  ['Lei nº 14.133/2021.', 'Lei 14.133/2021.', 'Lei nº 14.133/2012.'],
  ['Lei 8.666/93.', 'Lei nº 8.666/1993.', 'Lei 8.666/94.'],
  ['Lei 14.133.', 'Lei nº 14.133, de 2021.', 'Lei 14.113.'],
  // The summary may not add (or change) a year the source did not have.
  ['Lei 14.133.', 'Lei nº 14.133.', 'Lei 14.133/2012.'],
  ['Lei 14.133/2021.', 'Lei 14.133/2021.', 'Lei 14.133.'],
  ['Lei Complementar 101/2000.', 'LC 101/2000.', 'Lei 101/2000.'],
  ['Decreto nº 10.024/2019.', 'Decreto 10.024/2019.', 'Decreto 10.024/2020.'],
  ['Valor de R$ 1.000,00.', 'R$ 1.000.', 'R$ 10.000,00.'],
  ['Processo 0001234-56.2026.8.26.0100.', 'processo 0001234-56.2026.8.26.0100', 'processo 0001234-56.2026.8.26.0101'],
  ['Processo nº 123/2026.', 'processo 123 / 2026', 'processo 124/2026'],
  ['Protocolo 2026-000123.', 'protocolo 2026-000123', 'protocolo 2026-000132'],
  ['CPF 123.456.789-09.', 'CPF 123.456.789-09', 'CPF 123.456.789-90'],
  ['CNPJ 12.345.678/0001-90.', 'CNPJ 12.345.678/0001-90', 'CNPJ 12.345.678/0002-90'],
];

test('itens jurídicos: cada forma é reconhecida, a grafia equivalente passa e a troca é recusada', () => {
  for (const [source, kept, swapped] of LEGAL_CASES) {
    assert.ok(criticalItems(source).length > 0, 'sem itens: ' + source);
    assert.deepEqual(missingItems(source, kept), [], source + ' → ' + kept);
    assert.ok(missingItems(source, swapped).length > 0, source + ' → ' + swapped + ' deveria faltar');
  }
});

test('itens jurídicos: números pequenos sem unidade não viram itens; números dentro de outros não são confundidos', () => {
  assert.deepEqual(criticalItems('Foram 3 reuniões e 2 pareceres.'), []);
  assert.deepEqual(missingItems('art. 7 e 30 dias', 'art. 75 e 300 dias'), ['art. 7', '30 dias']);
  assert.deepEqual(missingItems('§ 1º', '§ 10'), ['§ 1']);
  assert.deepEqual(missingItems('12 meses', '112 meses'), ['12 meses']);
  // Each key only matches its own kind: an ordinal elsewhere is not an article or a paragraph, and vice versa.
  assert.deepEqual(missingItems('Conforme o art. 2º.', 'O 2º colocado venceu.'), ['art. 2']);
  assert.deepEqual(missingItems('Pelo § 2º.', 'O 2º colocado venceu.'), ['§ 2']);
  assert.deepEqual(missingItems('O 2º colocado venceu.', 'Conforme o art. 2º e o § 2º.'), ['2º']);
  assert.deepEqual(missingItems('Em 15/03/2026.', 'Processo 15.03.2026-1.'), ['15/03/2026']);
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

// ---------------------------------------------------------------------------------------------------------------
// E4 final wave

const hs = require('../dist/ai/history-summary');

test('summaryThreshold: 10 a 40 (acima de 40 o resto não resumido não caberia na janela de 40 mensagens)', () => {
  assert.equal(hs.SUMMARY_MAX_THRESHOLD, 40);
  assert.equal(hs.summaryThreshold(80), 40);
  assert.equal(hs.summaryThreshold(41), 40);
  assert.equal(hs.summaryThreshold(40), 40);
  assert.equal(hs.summaryThreshold(5), 10);
  assert.equal(hs.summaryThreshold(Number.NaN), 20);
});

test('valores e quantidades com multiplicador: o multiplicador faz parte do item', () => {
  assert.deepEqual(missingItems('Estimado em R$ 1,5 milhão.', 'Estimado em R$ 1,5.'), ['r$ 1,5 milhão']);
  assert.deepEqual(missingItems('Estimado em R$ 1,5 milhão.', 'Estimado em R$ 1,5 mil.'), ['r$ 1,5 milhão']);
  assert.deepEqual(missingItems('Estimado em R$ 1,5 milhão.', 'Valor: R$ 1,5 milhões.'), []);
  assert.deepEqual(missingItems('Teto de R$ 300 mil.', 'Teto de R$ 300.'), ['r$ 300 mil']);
  assert.deepEqual(missingItems('Orçamento de 2 bilhões de reais.', 'Orçamento de 2 reais.'), ['2 bilhões de reais']);
  assert.deepEqual(missingItems('Orçamento de 2 bilhões de reais.', 'Orçamento de 2 bilhões de reais.'), []);
  // A plain value is still a plain value.
  assert.deepEqual(missingItems('R$ 59.906,02', 'R$ 59.906,02'), []);
  assert.deepEqual(missingItems('R$ 59.906,02 milionário', 'R$ 59.906,02'), []);
});

test('summaryMaxTokens: 40% dos tokens do texto substituído, com piso de 256 e teto de 1.500 / do modelo', () => {
  const replaced = 'a'.repeat(8000); // 2,000 tokens
  assert.equal(hs.summaryMaxTokens(replaced), 800);
  assert.equal(hs.summaryMaxTokens('a'.repeat(400)), hs.SUMMARY_MIN_OUTPUT_TOKENS);
  assert.equal(hs.summaryMaxTokens('a'.repeat(60_000)), SUMMARY_MAX_TOKENS);
  assert.equal(hs.summaryMaxTokens(replaced, 500), 500);
  assert.equal(hs.summaryMaxTokens(replaced, 0), 800);
});

test('summaryTooLong: resumo com 70% ou mais do texto substituído não economiza', () => {
  assert.equal(hs.SUMMARY_MAX_KEPT_RATIO, 0.7);
  assert.equal(hs.SUMMARY_MIN_SOURCE_CHARS, 6000);
  assert.equal(hs.summaryTooLong('x'.repeat(700), 'y'.repeat(1000)), true);
  assert.equal(hs.summaryTooLong('x'.repeat(699), 'y'.repeat(1000)), false);
});
