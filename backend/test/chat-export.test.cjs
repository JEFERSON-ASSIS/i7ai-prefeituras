const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const ExcelJS = require('exceljs');
const { PDFParse } = require('pdf-parse');
const { parseAnswer, renderPdf, renderDocx, renderXlsx, exportTitle, exportFileName, typedCell, winAnsi, EXPORT_DISCLAIMER } = require('../dist/ai/chat-export');
const { AiGatewayService, CHAT_EXPORT_INSTRUCTIONS } = require('../dist/ai/ai-gateway.service');

const answer = [
  '# Termo de Referência — Locação de Software',
  '',
  'Contratação de **sistema de gestão** para a *Assistência Social*. ⚠️ Revisar valores.',
  '',
  '## Itens',
  '',
  '1. Licença anual',
  '2. Implantação',
  '   - Treinamento de `servidores`',
  '',
  '> Documento sujeito à revisão jurídica.',
  '',
  '| Item | Valor | Vigência |',
  '| --- | ---: | --- |',
  '| Licença | R$ 125.000,50 | 31/12/2026 |',
  '| Suporte | 1.200 | 31/03/2027 |',
  '',
  '<script>alert(1)</script>',
].join('\n');
const doc = (blocks = parseAnswer(answer)) => ({ title: exportTitle(blocks), organization: 'Prefeitura de Teste', generatedAt: new Date('2026-10-06T15:00:00Z'), blocks });

test('converte Markdown em blocos neutros e ignora HTML cru', () => {
  const blocks = parseAnswer(answer);
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'paragraph', 'heading', 'listItem', 'listItem', 'listItem', 'quote', 'table', 'paragraph']);
  assert.deepEqual(blocks[1].inlines.filter(item => item.bold).map(item => item.text), ['sistema de gestão']);
  assert.deepEqual(blocks.slice(3, 6).map(item => [item.ordered, item.number, item.level]), [[true, 1, 0], [true, 2, 0], [false, 1, 1]]);
  assert.deepEqual(blocks[7].header, ['Item', 'Valor', 'Vigência']);
  assert.deepEqual(blocks[7].rows[0], ['Licença', 'R$ 125.000,50', '31/12/2026']);
  assert.equal(blocks[8].inlines.map(item => item.text).join(''), '<script>alert(1)</script>', 'HTML permanece texto literal');
  assert.equal(exportTitle(blocks), 'Termo de Referência — Locação de Software');
  assert.equal(exportTitle(parseAnswer('Sem título.'), 'Conversa X'), 'Conversa X');
  assert.equal(exportFileName('Termo de Referência — Locação', 'pdf', new Date('2026-10-06T12:00:00Z')), 'Termo-de-Referencia-Locacao-2026-10-06.pdf');
});

test('quebra de linha simples do modelo é preservada nos campos do documento', async () => {
  const blocks = parseAnswer('**Tipo:** Especificação\n**Área:** Assistência Social');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].inlines.map(item => item.text).join(''), 'Tipo: Especificação\nÁrea: Assistência Social');
  const JSZip = require('jszip');
  const xml = await (await JSZip.loadAsync(await renderDocx(doc(blocks)))).file('word/document.xml').async('string');
  assert.match(xml, /Especificação<\/w:t><\/w:r>.*<w:br\/>.*Área:/s, 'quebra manual entre os campos');
  assert.match(xml, /<w:jc w:val="left"\/>/, 'parágrafo com quebras não é justificado');
});

test('fontes padrão do PDF recebem apenas caracteres Windows-1252', () => {
  assert.equal(winAnsi('⚠️ Atenção → prazo ≥ 30 dias “ok” — fim 😀'), ' Atenção -> prazo >= 30 dias “ok” — fim ');
});

test('PDF contém cabeçalho da prefeitura, conteúdo, tabela e aviso de rascunho', async () => {
  const buffer = await renderPdf(doc());
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  const parser = new PDFParse({ data: buffer });
  const { text } = await parser.getText();
  await parser.destroy();
  for (const expected of ['Prefeitura de Teste', 'Termo de Referência', 'sistema de gestão', 'Licença anual', 'R$ 125.000,50', 'Documento sujeito à revisão jurídica', 'Página 1 de 1', 'Rascunho gerado com apoio de IA']) assert.ok(text.includes(expected), 'PDF sem: ' + expected + '\n' + text);
});

test('Word inclui conteúdo, cabeçalho e rodapé', async () => {
  const buffer = await renderDocx(doc());
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  const mammoth = require('mammoth');
  const { value } = await mammoth.extractRawText({ buffer });
  for (const expected of ['Termo de Referência', 'Licença anual', 'R$ 125.000,50']) assert.ok(value.includes(expected), 'DOCX sem: ' + expected);
  const xml = buffer.toString('latin1');
  assert.ok(xml.includes('word/header') && xml.includes('word/footer'));
});

test('Excel tipa moeda, número e data em pt-BR', async () => {
  assert.deepEqual(typedCell('R$ 125.000,50'), { value: 125000.5, numFmt: '"R$" #,##0.00' });
  assert.deepEqual(typedCell('1.200'), { value: 1200, numFmt: '#,##0' });
  assert.deepEqual(typedCell('012345'), { value: '012345' }, 'zeros à esquerda continuam texto');
  assert.deepEqual(typedCell('31/02/2026'), { value: '31/02/2026' }, 'data inválida continua texto');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await renderXlsx(doc()));
  const sheet = workbook.getWorksheet('Tabela');
  assert.equal(sheet.getCell('A1').value, 'Item');
  assert.equal(sheet.getCell('B2').value, 125000.5);
  assert.ok(sheet.getCell('C2').value instanceof Date);
  assert.equal(workbook.getWorksheet('Sobre').getCell('A5').value, EXPORT_DISCLAIMER);
  await assert.rejects(renderXlsx(doc(parseAnswer('Sem tabela.'))), /NO_TABLES/);
});

function gateway(messages) {
  const queries = [];
  const prisma = { message: { findFirst: async args => { queries.push(args); const where = args.where; return messages.find(item => item.id === where.id && item.conversationId === where.conversationId && item.role === where.role && item.tenantId === where.conversation.tenantId && item.userId === where.conversation.userId) || null; } } };
  return { service: new AiGatewayService(prisma), queries };
}
const stored = (overrides = {}) => ({ id: 'message-a', conversationId: 'conversation-a', role: 'assistant', tenantId: 'tenant-a', userId: 'user-a', content: answer, conversation: { title: 'Conversa', tenant: { name: 'Prefeitura de Teste' } }, ...overrides });

test('exportação exige resposta do próprio usuário e prefeitura', async () => {
  const { service, queries } = gateway([stored()]);
  const file = await service.exportMessage('tenant-a', 'user-a', 'conversation-a', 'message-a', 'pdf');
  assert.match(file.getHeaders().disposition, /filename\*=UTF-8''Termo-de-Referencia-Locacao-de-Software-\d{4}-\d{2}-\d{2}\.pdf/);
  assert.equal(file.getHeaders().type, 'application/pdf');
  assert.deepEqual(queries[0].where, { id: 'message-a', conversationId: 'conversation-a', role: 'assistant', conversation: { tenantId: 'tenant-a', userId: 'user-a' } });
  await assert.rejects(service.exportMessage('tenant-a', 'user-b', 'conversation-a', 'message-a', 'pdf'), /Resposta não encontrada/);
  await assert.rejects(service.exportMessage('tenant-b', 'user-a', 'conversation-a', 'message-a', 'docx'), /Resposta não encontrada/);
});

test('Excel sem tabela e resposta vazia são recusados com orientação', async () => {
  const { service } = gateway([stored({ content: 'Apenas texto.' }), stored({ id: 'message-b', content: '   ' })]);
  await assert.rejects(service.exportMessage('tenant-a', 'user-a', 'conversation-a', 'message-a', 'xlsx'), /não contém tabelas/);
  await assert.rejects(service.exportMessage('tenant-a', 'user-a', 'conversation-a', 'message-b', 'pdf'), /não tem conteúdo/);
});

test('instrução de plataforma proíbe código gerador e recusa de arquivos', () => {
  assert.match(CHAT_EXPORT_INSTRUCTIONS, /PDF, Word \(\.docx\) e Excel/);
  assert.match(CHAT_EXPORT_INSTRUCTIONS, /Nunca forneça código/);
});
