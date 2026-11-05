const test = require('node:test');
const assert = require('node:assert/strict');
const { limparTextoExtraido, chunkDocument } = require('../dist/knowledge/document-extractor');

test('texto extraído sem o caractere nulo, que o PostgreSQL recusa (PDF com ligadura "fi" virando \\u0000)', () => {
  const sujo = 'encaminhar o o\u0000cio anexo\r\n\r\n\r\n\r\nCom\u0007 controle\t\t e  espaços';
  const limpo = limparTextoExtraido(sujo);
  assert.equal(limpo.includes('\u0000'), false);
  assert.equal(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(limpo), false);
  assert.equal(limpo, 'encaminhar o ocio anexo\n\nCom controle e espaços');
  for (const pedaco of chunkDocument(limpo.repeat(200))) assert.equal(pedaco.includes('\u0000'), false);
});
