const test = require('node:test'); const assert = require('node:assert/strict');
const { THEMES, THEME_VERSION, classifyTheme, themeLabel, normalizeText } = require('../dist/sgdm/themes');
const { maskPersonalData } = require('../dist/sgdm/personal-data');

test('fixed list: 15 themes in table order, version 1', () => {
  assert.equal(THEME_VERSION, 1);
  assert.deepEqual(THEMES.map(theme => theme.id), ['licitacoes', 'juridico', 'documentos', 'pessoal', 'tributos', 'financas', 'saude', 'educacao', 'assistencia', 'obras', 'meio-ambiente', 'atendimento', 'tecnologia', 'texto', 'outros']);
  assert.equal(normalizeText('  CONTRATAÇÃO   Emergencial '), 'contratacao emergencial');
});

test('title hits score 2, ties go to table order', () => {
  assert.equal(classifyTheme('Preciso de um parecer sobre a lei de licitações 14.133', 'Assistente'), 'licitacoes');
  assert.equal(classifyTheme('Recurso do CPF 123.456.789-00, tel (65) 99999-1234', 'Assistente'), 'juridico');
});

test('short keywords match whole words with optional plural; long ones match word starts', () => {
  assert.equal(classifyTheme('Leitura do relatório', 'Assistente'), 'outros');
  assert.equal(classifyTheme('Leis municipais', 'Assistente'), 'juridico');
  assert.equal(classifyTheme('Obras da praça', 'x'), 'obras');
  assert.equal(classifyTheme('CONTRATAÇÃO EMERGENCIAL', 'x'), 'licitacoes');
  assert.equal(classifyTheme('Processo 14x133', 'x'), 'outros');
});

test('agent name counts 1 and is the only signal without a title', () => {
  assert.equal(classifyTheme(null, 'Assistente de Saúde'), 'saude');
  assert.equal(classifyTheme(null, 'Assistente'), 'outros');
  assert.equal(classifyTheme('', 'Assistente'), 'outros');
  // One title hit (2) beats one agent-name hit (1).
  assert.equal(classifyTheme('Resumo do texto', 'Assistente de Saúde'), 'texto');
});

test('unknown theme ids read as Outros', () => {
  assert.equal(themeLabel('nao-existe'), 'Outros');
  assert.equal(themeLabel('licitacoes'), 'Licitações e contratos');
});

test('masks e-mail, CNPJ, CPF, phone and long digit runs, in that order', () => {
  assert.equal(
    maskPersonalData('Recurso do CPF 123.456.789-00, tel (65) 99999-1234, joao@x.gov.br, CNPJ 12.345.678/0001-90, processo 2026001234'),
    'Recurso do CPF [CPF], tel [telefone], [e-mail], CNPJ [CNPJ], processo [número]');
  assert.equal(maskPersonalData('Lei 14.133 de 2021'), 'Lei 14.133 de 2021');
  assert.equal(maskPersonalData('CPF 12345678900 e CNPJ 12345678000190'), 'CPF [CPF] e CNPJ [CNPJ]');
  assert.equal(maskPersonalData('Ligar 9999-1234'), 'Ligar [telefone]');
});
