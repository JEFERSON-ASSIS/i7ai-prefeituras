const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { validateChatAttachment } = require('../dist/knowledge/chat-attachment-validation');
const { extractDocumentText, validateDocument } = require('../dist/knowledge/document-extractor');

const upload = (name, mime, buffer) => ({ originalname: name, mimetype: mime, size: buffer.length, buffer });
function xlsBuffer() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Item', 'Valor'], ['Caneta azul', 12.5], ['Resma de papel', 30]]), 'Compras');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }));
}
const fs = require('node:fs');
const path = require('node:path');
const docBuffer = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'termo-referencia.doc'));

test('legacy XLS is validated and extracted as sheet text', async () => {
  const buffer = xlsBuffer();
  assert.deepEqual(buffer.subarray(0, 4), Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  const result = await validateChatAttachment(upload('Planilha.xls', 'application/vnd.ms-excel', buffer));
  assert.equal(result.mimeType, 'application/vnd.ms-excel');
  const text = await extractDocumentText('Planilha.xls', buffer);
  assert.match(text, /\[Planilha: Compras\]/);
  assert.match(text, /Caneta azul/);
  assert.match(text, /Resma de papel/);
});

test('legacy DOC is validated and extracted as text', async () => {
  const buffer = docBuffer();
  assert.ok(buffer.length <= 30 * 1024);
  const result = await validateChatAttachment(upload('TR - Termo de Referência.doc', 'application/msword', buffer));
  assert.equal(result.mimeType, 'application/msword');
  assert.match(await extractDocumentText('TR - Termo de Referência.doc', buffer), /Termo de Refer/);
  assert.equal(validateDocument(upload('a.doc', 'application/octet-stream', buffer)), 'application/msword');
});

test('non-OLE .doc and .xls are rejected with a clear message', async () => {
  await assert.rejects(validateChatAttachment(upload('falso.doc', 'application/msword', Buffer.from('texto simples'))), /Este \.doc não é um documento do Word válido\. Salve como \.docx e anexe de novo\./);
  await assert.rejects(validateChatAttachment(upload('falso.xls', 'application/vnd.ms-excel', Buffer.from('{\rtf1 x}'))), /Salve como \.xlsx/);
});

test('zip and unknown extensions return the exact messages', async () => {
  await assert.rejects(validateChatAttachment(upload('a.zip', 'application/zip', Buffer.from('PK'))), { message: 'Arquivos .zip não são lidos no chat. Extraia e anexe os arquivos de dentro (PDF, Word, Excel ou texto).' });
  await assert.rejects(validateChatAttachment(upload('a.exe', 'application/octet-stream', Buffer.from('MZ'))), { message: 'Formato .exe não suportado. Use PDF, Word (.doc/.docx), Excel (.xls/.xlsx), CSV ou texto.' });
});

const { runLegacyOffice } = require('../dist/knowledge/document-extractor');
function sheetBuffer(build) {
  const workbook = XLSX.utils.book_new();
  build(workbook);
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }));
}

test('sparse XLS with a huge declared range is refused quickly', async () => {
  const buffer = sheetBuffer(workbook => {
    const sheet = { A1: { t: 's', v: 'x' }, IV8200: { t: 's', v: 'y' }, '!ref': 'A1:IV8200' };
    XLSX.utils.book_append_sheet(workbook, sheet, 'Esparsa');
  });
  assert.ok(buffer.length < 20 * 1024);
  const started = Date.now();
  await assert.rejects(extractDocumentText('esparsa.xls', buffer), /grande demais para ser lida no chat/);
  assert.ok(Date.now() - started < 10000, `levou ${Date.now() - started} ms`);
});

test('XLS with more than 50 sheets is refused', async () => {
  const buffer = sheetBuffer(workbook => { for (let i = 0; i < 60; i++) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['a']]), 'P' + i); });
  await assert.rejects(extractDocumentText('muitas.xls', buffer), /grande demais para ser lida no chat/);
});

test('legacy parser worker is terminated on timeout', async () => {
  await assert.rejects(runLegacyOffice('xls', xlsBuffer(), 1), { message: 'O processamento do arquivo excedeu o tempo limite.' });
});
