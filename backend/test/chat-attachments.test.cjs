const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { createCanvas } = require('@napi-rs/canvas');
const ExcelJS = require('exceljs');
const { KnowledgeService, publicChatAttachment } = require('../dist/knowledge/knowledge.service');
const { DocumentPipelineService } = require('../dist/knowledge/document-pipeline.service');
const { validateChatAttachment, CHAT_ATTACHMENT_MAX_BYTES, CHAT_IMAGE_MAX_BYTES, chatAttachmentCapabilities } = require('../dist/knowledge/chat-attachment-validation');
const { ChatAttachmentsController } = require('../dist/ai/chat-attachments.controller');
const { chunkDocument } = require('../dist/knowledge/document-extractor');

const upload = (name, mime, buffer) => ({ originalname: name, mimetype: mime, size: buffer.length, buffer });
const png = () => createCanvas(2, 2).toBuffer('image/png');
const row = (id = 'document-a', overrides = {}) => ({ id, tenantId: 'tenant-a', ownerUserId: 'user-a', chatOnly: true, name: 'relatorio.txt', mimeType: 'text/plain', storageKey: 'tenant-a/private-' + id, sizeBytes: 8n, status: 'READY', errorMessage: null, createdAt: new Date(), chunks: [{ chunkIndex: 0, content: 'Dados reais do relatório.' }], messageAttachments: [], ...overrides });

function matches(record, where) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'messageAttachments') return !record.messageAttachments?.length;
    if (key === 'createdAt' && value.lt) return record.createdAt < value.lt;
    if (value && typeof value === 'object' && value.in) return value.in.includes(record[key]);
    return record[key] === value;
  });
}
function fixture(initial = []) {
  const records = [...initial], calls = [], objects = new Map(), audits = [], queued = [];
  const prisma = {
    $queryRaw: async sql => { assert.match(sql.sql, /FOR UPDATE/); calls.push('lock'); return []; },
    license: { findFirst: async () => null },
    user: { findFirst: async ({ where }) => where.id === 'user-a' && where.tenantId === 'tenant-a' ? { id: 'user-a' } : null },
    document: {
      aggregate: async () => ({ _sum: { sizeBytes: records.reduce((sum, item) => sum + BigInt(item.sizeBytes), 0n) } }),
      findFirst: async ({ where, include }) => {
        calls.push({ findFirst: where });
        const found = records.find(item => matches(item, where));
        return found && { ...found, ...(include?._count ? { _count: { messageAttachments: found.messageAttachments.length } } : {}) };
      },
      findMany: async ({ where }) => {
        calls.push({ findMany: where });
        return records.filter(item => matches(item, where)).map(item => ({ ...item, _count: { chunks: item.totalChunks ?? item.chunks.length } }));
      },
      create: async ({ data }) => { calls.push('reserve'); const created = row('created-' + records.length, data); records.push(created); return created; },
      update: async ({ where, data }) => { const found = records.find(item => item.id === where.id); Object.assign(found, data); return found; },
      deleteMany: async ({ where }) => { calls.push('release'); const selected = records.filter(item => matches(item, where)); selected.forEach(item => records.splice(records.indexOf(item), 1)); return { count: selected.length }; },
    },
    auditLog: { create: async ({ data }) => { audits.push(data); return data; } },
  };
  prisma.$transaction = async callback => callback(prisma);
  const service = new KnowledgeService(prisma, { enqueue: async id => queued.push(id) });
  service.s3 = { send: async command => {
    calls.push(command.constructor.name);
    if (command.constructor.name === 'PutObjectCommand') objects.set(command.input.Key, command.input.Body);
    if (command.constructor.name === 'DeleteObjectCommand') objects.delete(command.input.Key);
    if (command.constructor.name === 'GetObjectCommand') return { Body: objects.get(command.input.Key) };
    return {};
  } };
  return { service, prisma, records, calls, objects, audits, queued };
}

test('chat uploads validate MIME, extension, binary text, size, filenames, and unsupported formats before storage', async () => {
  await assert.rejects(validateChatAttachment(), /Selecione/);
  await assert.rejects(validateChatAttachment(upload('a.zip', 'application/zip', Buffer.from('PK'))), /Arquivos \.zip não são lidos/);
  await assert.rejects(validateChatAttachment(upload('a.xls', 'application/vnd.ms-excel', Buffer.from('sheet'))), /não é uma planilha do Excel válida/);
  await assert.rejects(validateChatAttachment(upload('a.exe', 'application/octet-stream', Buffer.from('MZ'))), /suportado/);
  await assert.rejects(validateChatAttachment(upload('a.txt', 'image/png', Buffer.from('texto'))), /MIME/);
  await assert.rejects(validateChatAttachment(upload('a.txt', 'text/plain', Buffer.from([0, 1]))), /binários/);
  await assert.rejects(validateChatAttachment(upload('a.txt', 'text/plain', Buffer.from([0xff, 0xff]))), /UTF-8/);
  await assert.rejects(validateChatAttachment(upload('.txt', 'text/plain', Buffer.from('texto'))), /Nome/);
  await assert.rejects(validateChatAttachment({ ...upload('a.txt', 'text/plain', Buffer.from('a')), size: 3 }), /tamanho/);
  await assert.rejects(validateChatAttachment(upload('a.txt', 'text/plain', Buffer.alloc(CHAT_ATTACHMENT_MAX_BYTES + 1, 97))), /20 MB/);
  assert.equal((await validateChatAttachment(upload('..\\relatorio.txt', 'application/octet-stream', Buffer.from('texto')))).name, 'relatorio.txt');
  const f = fixture();
  await assert.rejects(f.service.uploadChatAttachment('tenant-a', 'user-a', upload('a.txt', 'image/png', Buffer.from('texto'))), /MIME/);
  assert.equal(f.calls.length, 0);
});

test('images must match signature, MIME and bounded dimensions, and decode as real pixels', async () => {
  const result = await validateChatAttachment(upload('captura.png', 'image/png', png()));
  assert.equal(result.image, true); assert.equal(result.mimeType, 'image/png');
  await assert.rejects(validateChatAttachment(upload('captura.jpg', 'image/jpeg', png())), /JPEG válida/);
  await assert.rejects(validateChatAttachment(upload('captura.png', 'image/jpeg', png())), /MIME/);
  const bomb = png(); bomb.writeUInt32BE(20000, 16);
  await assert.rejects(validateChatAttachment(upload('captura.png', 'image/png', bomb)), /pixels/);
  await assert.rejects(validateChatAttachment(upload('captura.png', 'image/png', png().subarray(0, 33))), /decodificar/);
  await assert.rejects(validateChatAttachment(upload('captura.png', 'image/png', Buffer.alloc(CHAT_IMAGE_MAX_BYTES + 1))), /10 MB/);
  for (const [format, extension, mime] of [['image/jpeg', 'jpg', 'image/jpeg'], ['image/webp', 'webp', 'image/webp']]) {
    const buffer = createCanvas(2, 2).toBuffer(format);
    assert.equal((await validateChatAttachment(upload('captura.' + extension, mime, buffer))).image, true);
  }
});

test('Office attachment validator accepts a real XLSX and blocks archive expansion before extraction', async () => {
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Dados').addRow(['Saúde', 30]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  assert.equal((await validateChatAttachment(upload('dados.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer))).image, false);
  const bomb = Buffer.from(buffer), directory = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(70 * 1024 * 1024, directory + 24);
  await assert.rejects(validateChatAttachment(upload('dados.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bomb)), /64 MB/);
  await assert.rejects(validateChatAttachment(upload('dados.xlsx', 'application/zip', Buffer.from('PKbad-office'))), /Office válido/);
});

test('Office validator rejects understated expansion and inconsistent local/central member headers', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Dados').addRow(['Conteúdo real maior que o tamanho adulterado', 'a'.repeat(2000)]);
  const original = Buffer.from(await workbook.xlsx.writeBuffer());
  const marker = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let central = original.indexOf(marker);
  while (central >= 0) {
    const nameLength = original.readUInt16LE(central + 28);
    const name = original.toString('utf8', central + 46, central + 46 + nameLength);
    if (name === 'xl/worksheets/sheet1.xml') break;
    central = original.indexOf(marker, central + 4);
  }
  assert.ok(central >= 0);
  const local = original.readUInt32LE(central + 42);
  assert.ok(original.readUInt32LE(central + 24) > 1);
  const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const understatedCentral = Buffer.from(original); understatedCentral.writeUInt32LE(1, central + 24);
  await assert.rejects(validateChatAttachment(upload('dados.xlsx', mime, understatedCentral)), /inconsistentes/);
  const understatedBoth = Buffer.from(understatedCentral); understatedBoth.writeUInt32LE(1, local + 22);
  await assert.rejects(validateChatAttachment(upload('dados.xlsx', mime, understatedBoth)), /tamanho real descompactado/);
  const wrongMethod = Buffer.from(original); wrongMethod.writeUInt16LE(0, local + 8);
  await assert.rejects(validateChatAttachment(upload('dados.xlsx', mime, wrongMethod)), /inconsistentes/);
  const wrongFilename = Buffer.from(original); wrongFilename[local + 30] = 0x79;
  await assert.rejects(validateChatAttachment(upload('dados.xlsx', mime, wrongFilename)), /inconsistentes/);
});

test('private attachment APIs require both tenant and owner and never disclose storage location', async () => {
  const f = fixture([row()]);
  const metadata = await f.service.getChatAttachment('tenant-a', 'user-a', 'document-a');
  assert.deepEqual(Object.keys(metadata), ['id', 'name', 'mimeType', 'sizeBytes', 'status', 'errorMessage']);
  assert.equal(metadata.sizeBytes, '8'); assert.equal(publicChatAttachment(row()).storageKey, undefined);
  for (const [tenant, user] of [['tenant-b', 'user-a'], ['tenant-a', 'user-b']]) {
    await assert.rejects(f.service.getChatAttachment(tenant, user, 'document-a'), /não encontrado/);
    await assert.rejects(f.service.downloadChatAttachment(tenant, user, 'document-a'), /não encontrado/);
    await assert.rejects(f.service.removeChatAttachment(tenant, user, 'document-a'), /não encontrado/);
    await assert.rejects(f.service.prepareChatAttachments(tenant, user, ['document-a']), /não foram encontrados/);
  }
  assert.equal(f.calls.some(call => call === 'GetObjectCommand' || call === 'DeleteObjectCommand'), false);
});

test('knowledge document list/download/update paths explicitly exclude private chat attachments', async () => {
  const f = fixture([row(), row('shared', { chatOnly: false, ownerUserId: null })]);
  assert.equal((await f.service.listDocuments('tenant-a')).length, 1);
  await assert.rejects(f.service.download('tenant-a', 'document-a'), /não encontrado/);
  await assert.rejects(f.service.assignBase('tenant-a', 'document-a', null), /não encontrado/);
  await assert.rejects(f.service.reprocess('tenant-a', 'document-a'), /não encontrado/);
  await assert.rejects(f.service.removeDocument('tenant-a', 'document-a'), /não encontrado/);
  assert.ok(f.calls.filter(call => call?.findFirst || call?.findMany).every(call => (call.findFirst || call.findMany).chatOnly === false));
});

test('chat preparation sends actual extracted text and stored image bytes with safe metadata', async () => {
  const image = row('image', { name: 'captura.png', mimeType: 'image/png', chunks: [] });
  const f = fixture([row(), image]); f.objects.set(image.storageKey, png());
  const prepared = await f.service.prepareChatAttachments('tenant-a', 'user-a', ['document-a', 'image']);
  assert.match(prepared.text, /Dados reais do relatório/);
  assert.equal(prepared.documents.length, 2); assert.equal(prepared.documents[0].ownerUserId, undefined);
  assert.equal(prepared.images.length, 1); assert.equal(prepared.images[0].dataUrl, 'data:image/png;base64,' + png().toString('base64'));
  const pending = fixture([row('pending', { status: 'PROCESSING' })]);
  await assert.rejects(pending.service.prepareChatAttachments('tenant-a', 'user-a', ['pending']), /sendo processado/);
  assert.equal(pending.calls.some(call => call === 'GetObjectCommand'), false);
  await assert.rejects(f.service.prepareChatAttachments('tenant-a', 'user-a', ['image', 'image']), /cinco anexos/);
  await assert.rejects(f.service.prepareChatAttachments('tenant-a', 'user-a', Array.from({ length: 6 }, (_, i) => String(i))), /cinco anexos/);
});

test('long attachment text is bounded and carries an explicit notice of partial analysis', async () => {
  const f = fixture([row('long', { chunks: [{ chunkIndex: 0, content: 'a'.repeat(60000) }], totalChunks: 100 })]);
  const result = await f.service.prepareChatAttachments('tenant-a', 'user-a', ['long']);
  assert.match(result.text, /Aviso:.*48\.000 caracteres/);
  assert.ok(result.text.length < 48300);
});

test('trimmed and repetitive chunk boundaries retain all selected characters without guessed overlap', async () => {
  const source = 'a'.repeat(1049) + '\n\n' + 'b'.repeat(1800);
  const chunks = chunkDocument(source).map((content, chunkIndex) => ({ content, chunkIndex }));
  const f = fixture([row('boundary', { chunks })]);
  const prepared = await f.service.prepareChatAttachments('tenant-a', 'user-a', ['boundary']);
  for (const chunk of chunks) assert.ok(prepared.text.includes(`[Trecho ${chunk.chunkIndex + 1}]\n${chunk.content}`));
  const expectedB = chunks.reduce((count, chunk) => count + (chunk.content.match(/b/g)?.length || 0), 0);
  // Header contains one additional b in "sobreposição".
  assert.equal(prepared.text.match(/b/g).length, expectedB + 1);
  assert.match(prepared.text, /sobreposição não representa dados adicionais/);
});

test('upload reserves existing storage quota, stores images READY, and queues text privately', async () => {
  const f = fixture();
  const image = await f.service.uploadChatAttachment('tenant-a', 'user-a', upload('captura.png', 'image/png', png()));
  assert.equal(image.status, 'READY'); assert.equal(f.queued.length, 0); assert.equal(image.storageKey, undefined);
  assert.equal(f.records[0].ownerUserId, 'user-a'); assert.equal(f.records[0].chatOnly, true);
  assert.ok(f.calls.indexOf('reserve') < f.calls.indexOf('PutObjectCommand'));
  const text = await f.service.uploadChatAttachment('tenant-a', 'user-a', upload('dados.csv', 'text/csv', Buffer.from('item,total\nsaude,30')));
  assert.equal(text.status, 'PROCESSING'); assert.equal(f.queued.length, 1);
  assert.equal(f.audits.every(audit => audit.event === 'chat_attachment.uploaded'), true);
  const denied = fixture(); denied.prisma.license.findFirst = async () => ({ status: 'ACTIVE', startDate: new Date(0), maxStorageBytes: 1n });
  await assert.rejects(denied.service.uploadChatAttachment('tenant-a', 'user-a', upload('a.txt', 'text/plain', Buffer.from('abc'))), /armazenamento/);
  assert.equal(denied.calls.includes('PutObjectCommand'), false); assert.equal(denied.records.length, 0);
});

test('failed private storage releases database reservation and ownership is checked before upload', async () => {
  const f = fixture(); f.service.s3.send = async () => { throw Error('private-storage-error'); };
  await assert.rejects(f.service.uploadChatAttachment('tenant-a', 'user-a', upload('a.txt', 'text/plain', Buffer.from('texto'))), /salvar o arquivo/);
  assert.equal(f.records.length, 0); assert.equal(f.queued.length, 0);
  const foreign = fixture();
  await assert.rejects(foreign.service.uploadChatAttachment('tenant-a', 'user-b', upload('a.txt', 'text/plain', Buffer.from('texto'))), /Usuário não encontrado/);
  assert.equal(foreign.calls.includes('reserve'), false); assert.equal(foreign.calls.includes('PutObjectCommand'), false);
});

test('linked or processing attachments cannot be removed from history', async () => {
  for (const document of [row('linked', { messageAttachments: [{ messageId: 'message-a' }] }), row('pending', { status: 'PROCESSING' })]) {
    const f = fixture([document]);
    await assert.rejects(f.service.removeChatAttachment('tenant-a', 'user-a', document.id), /histórico|processamento/);
    assert.equal(f.calls.includes('DeleteObjectCommand'), false); assert.equal(f.records.length, 1);
  }
  const f = fixture([row()]);
  assert.deepEqual(await f.service.removeChatAttachment('tenant-a', 'user-a', 'document-a'), { id: 'document-a', deleted: true });
  assert.equal(f.records.length, 0);
});

test('orphan cleanup deletes S3 before releasing quota and preserves recent, linked and raced attachments', async () => {
  const old = new Date(Date.now() - 25 * 3600000);
  const f = fixture([row('old', { createdAt: old }), row('recent'), row('linked', { createdAt: old, messageAttachments: [{ messageId: 'message-a' }] }), row('shared', { createdAt: old, chatOnly: false })]);
  assert.deepEqual(await f.service.cleanupOrphanChatAttachments(), { deleted: 1 });
  assert.ok(f.calls.indexOf('DeleteObjectCommand') < f.calls.indexOf('release'));
  assert.deepEqual(f.records.map(item => item.id), ['recent', 'linked', 'shared']);
  const raced = fixture([row('raced', { createdAt: old })]);
  raced.prisma.$queryRaw = async () => { raced.records[0].messageAttachments.push({ messageId: 'new-message' }); return []; };
  assert.deepEqual(await raced.service.cleanupOrphanChatAttachments(), { deleted: 0 });
  assert.equal(raced.calls.includes('DeleteObjectCommand'), false);
  const offline = fixture([row('offline', { createdAt: old })]); offline.service.s3.send = async () => { throw Error('S3 unavailable'); };
  assert.deepEqual(await offline.service.cleanupOrphanChatAttachments(), { deleted: 0 }); assert.equal(offline.records.length, 1);
});

test('orphan cleanup covers abandoned owners, different tenants and failed or stale processing statuses', async () => {
  const old = new Date(Date.now() - 25 * 3600000);
  const f = fixture([
    row('ready-a', { createdAt: old }),
    row('failed-b', { tenantId: 'tenant-b', ownerUserId: 'user-b', status: 'FAILED', createdAt: old }),
    row('stale-worker', { ownerUserId: null, status: 'PROCESSING', createdAt: old }),
    row('fresh-worker', { tenantId: 'tenant-b', ownerUserId: 'user-b', status: 'PROCESSING' }),
    row('linked-b', { tenantId: 'tenant-b', ownerUserId: 'user-b', createdAt: old, messageAttachments: [{ messageId: 'message-b' }] }),
  ]);
  assert.deepEqual(await f.service.cleanupOrphanChatAttachments(), { deleted: 3 });
  assert.deepEqual(f.records.map(document => document.id), ['fresh-worker', 'linked-b']);
  const scopedChecks = f.calls.filter(call => call?.findFirst).map(call => call.findFirst);
  assert.ok(scopedChecks.every(where => where.tenantId && where.chatOnly === true && where.messageAttachments.none));
});

test('private document worker extracts real text without sending embeddings to another provider', async () => {
  const document = row(); const chunks = [], statuses = [];
  const prisma = { document: { findFirst: async () => document, updateMany: async ({ data }) => statuses.push(data.status), update: async ({ data }) => statuses.push(data.status) }, documentChunk: { deleteMany: async () => {}, create: async ({ data }) => { chunks.push(data); return { id: 'chunk-a' }; } } };
  prisma.$transaction = async callback => callback(prisma);
  const worker = Object.create(DocumentPipelineService.prototype);
  worker.prisma = prisma; worker.s3 = { send: async () => ({ Body: Buffer.from('Dados privados reais') }) }; worker.bucket = 'test';
  worker.embeddings = { embed: async () => { throw Error('Private text must never be embedded externally'); } };
  await worker.process({ data: { documentId: document.id, tenantId: document.tenantId }, attemptsMade: 0, opts: { attempts: 3 } });
  assert.deepEqual(statuses, ['PROCESSING', 'READY']); assert.equal(chunks[0].content, 'Dados privados reais'); assert.equal(chunks[0].metadata.embeddingModel, undefined);
});

test('controller delegates authenticated tenant and owner and capabilities list only supported types', () => {
  const calls = [], controller = new ChatAttachmentsController({ getChatAttachment: (...args) => calls.push(args) });
  controller.get({ user: { tenantId: 'tenant-a', sub: 'user-a' } }, 'document-a');
  assert.deepEqual(calls[0], ['tenant-a', 'user-a', 'document-a']);
  const caps = chatAttachmentCapabilities(); assert.equal(caps.maxFiles, 5); assert.equal(caps.extensions.includes('zip'), false); assert.equal(caps.extensions.includes('xls'), true); assert.equal(caps.extensions.includes('doc'), true); assert.equal(caps.extensions.includes('png'), true);
});
