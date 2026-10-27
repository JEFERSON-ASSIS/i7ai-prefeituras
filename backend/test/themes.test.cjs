const test = require('node:test'); const assert = require('node:assert/strict');
const { THEMES, THEME_VERSION, classifyTheme, themeLabel, normalizeText } = require('../dist/sgdm/themes');
const { maskPersonalData } = require('../dist/sgdm/personal-data');

test('fixed list: 15 themes in table order, version 1', () => {
  assert.equal(THEME_VERSION, 2);
  assert.deepEqual(THEMES.map(theme => theme.id), ['licitacoes', 'juridico', 'documentos', 'pessoal', 'tributos', 'financas', 'saude', 'educacao', 'assistencia', 'obras', 'meio-ambiente', 'atendimento', 'tecnologia', 'texto', 'outros']);
  assert.equal(normalizeText('  CONTRATAÇÃO   Emergencial '), 'contratacao emergencial');
});

test('title hits score 2, ties go to table order', () => {
  assert.equal(classifyTheme('Preciso de um parecer sobre a lei de licitações 14.133', 'Assistente'), 'licitacoes');
  assert.equal(classifyTheme('Recurso do CPF 123.456.789-00, tel (65) 99999-1234', 'Assistente'), 'juridico');
});

test('short keywords match whole words with optional plural; long ones match word starts', () => {
  assert.equal(classifyTheme('Leitura do caderno', 'Assistente'), 'outros');
  assert.equal(classifyTheme('Leitura do relatório', 'Assistente'), 'documentos');
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

test('masks long digit runs with single separators and keeps laws, dates and money', () => {
  assert.equal(maskPersonalData('CPF 123 456 789 00'), 'CPF [número]');
  assert.equal(maskPersonalData('RG 12.345.678-9'), 'RG [número]');
  assert.equal(maskPersonalData('tel 99999 1234'), 'tel [número]');
  assert.equal(maskPersonalData('898 0012 3456 7890'), '[número]');
  assert.equal(maskPersonalData('CPF 123.456.789.00'), 'CPF [número]');
  for (const keep of ['Lei 14.133 de 2021', 'Lei 14.133/2021', 'Reunião em 27/10/2026', 'Valor R$ 1.234.567,89']) assert.equal(maskPersonalData(keep), keep);
});

test('version 2 keywords cover common municipal requests', () => {
  const cases = {
    documentos: ['Ata da reunião do conselho', 'Convite para audiência', 'Convocação dos membros', 'Declaração de residência', 'Certidão negativa', 'Discurso do prefeito'],
    juridico: ['Projeto de lei sobre feiras', 'Adequação à LGPD', 'Legislação municipal', 'Instrução normativa', 'Regulamentação do uso', 'Acórdão do TCU'],
    pessoal: ['Recursos humanos da secretaria', 'Plano de cargos', 'Salário dos agentes', 'Remuneração de professores temporários', 'Adicional noturno', 'Escala de plantão'],
    tributos: ['Fiscalização de comércio', 'Contribuinte inadimplente', 'Cobrança administrativa'],
    licitacoes: ['Pesquisa de preços de material', 'Cotação de pneus', 'Credenciamento de clínicas', 'Chamamento público', 'Fiscal de contrato de limpeza'],
    obras: ['Revitalização da praça', 'Asfalto na avenida', 'Buraco na via', 'Calçada quebrada', 'Ponte do córrego', 'Trânsito no centro', 'Zeladoria urbana'],
    educacao: ['Ensino fundamental', 'Proposta pedagógica', 'Biblioteca municipal'],
    assistencia: ['Criança em situação de risco', 'Adolescente aprendiz', 'Conselho tutelar', 'Pessoa com deficiência'],
    saude: ['Médico plantonista', 'Equipe de enfermagem', 'Consulta especializada', 'Exame de imagem', 'Farmácia básica', 'SAMU regional'],
    atendimento: ['Solicitação de poda', 'Carta de serviços ao usuário'],
    tecnologia: ['Inteligência artificial no setor', 'Usar o ChatGPT', 'Aplicativo da prefeitura'],
    texto: ['Redigir um e-mail', 'Elaborar um resumo curto', 'Explicar esta norma em palavras simples'],
  };
  for (const [theme, titles] of Object.entries(cases)) for (const title of titles) assert.equal(classifyTheme(title, 'Assistente'), theme, title);
});

test('phrases consume their words and ties fall to the number of hits', () => {
  // "recursos humanos" is one pessoal hit, not also a juridico "recurso".
  assert.equal(classifyTheme('Recursos humanos', 'Assistente'), 'pessoal');
  assert.equal(classifyTheme('Recurso administrativo', 'Assistente'), 'juridico');
  // Same score (2 = one title hit vs two agent-name hits): more hits win.
  assert.equal(classifyTheme('Parecer', 'Saúde e hospital'), 'saude');
  // Same score and hits: table order.
  assert.equal(classifyTheme('Parecer sobre o edital', 'x'), 'licitacoes');
  // No themes beyond the fixed list.
  for (const title of ['Festival de cultura', 'Campeonato de esporte', 'Roteiro de turismo', 'Feira de agricultura familiar']) assert.equal(classifyTheme(title, 'Assistente'), 'outros', title);
  assert.equal(classifyTheme('Iara na rua do modelo de texto', 'Assistente'), 'outros');
});

test('masking: CPF and CNPJ only as whole runs; phones with or without parentheses, +55 and spaces', () => {
  for (const run of ['123456789012', '1234567890123', '123456789012345', '1234567890123456']) assert.equal(maskPersonalData('Processo ' + run), 'Processo [número]', run);
  assert.equal(maskPersonalData('Ligar 65 99999 1234'), 'Ligar [telefone]');
  assert.equal(maskPersonalData('Ligar +55 65 99999-1234'), 'Ligar [telefone]');
  assert.equal(maskPersonalData('Ligar (65) 3322-1100'), 'Ligar [telefone]');
  assert.equal(maskPersonalData('Ligar 65-3322-1100'), 'Ligar [telefone]');
  assert.equal(maskPersonalData('Processo 2026 123'), 'Processo 2026 123');
  assert.equal(maskPersonalData('Lei 14.133 de 2021, art. 75'), 'Lei 14.133 de 2021, art. 75');
});
