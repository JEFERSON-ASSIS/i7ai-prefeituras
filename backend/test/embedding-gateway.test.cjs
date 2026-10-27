const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('reflect-metadata');
const { EmbeddingService } = require('../dist/knowledge/embedding.service');
const { DocumentPipelineService } = require('../dist/knowledge/document-pipeline.service');

const KEYS = ['EMBEDDING_API_KEY', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_VIA_GATEWAY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OMNIROUTER_BASE_URL', 'OMNIROUTER_API_KEY'];
function withEnv(env, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  KEYS.forEach((k) => delete process.env[k]); Object.assign(process.env, env);
  const restore = () => KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  return Promise.resolve().then(fn).finally(restore);
}
async function server() {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body); requests.push({ auth: req.headers.authorization, body: json });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', model: json.model, usage: { prompt_tokens: 1, total_tokens: 1 }, data: json.input.map((_, index) => ({ object: 'embedding', index, embedding: Array(1536).fill(0.1) })) }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { requests, url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

test('via gateway: user is the tenant and tags carry origin, key source and user', async () => {
  const srv = await server();
  try {
    await withEnv({ EMBEDDING_BASE_URL: srv.url, EMBEDDING_API_KEY: 'k' }, async () => {
      await new EmbeddingService().embed(['a'], { tenantId: 'tenant-a', userId: 'user-1', origem: 'i7ai-embeddings' });
      await new EmbeddingService().embed(['b'], { tenantId: 'tenant-a', origem: 'i7ai-embeddings' });
    });
    assert.equal(srv.requests[0].body.user, 'tenant-a');
    assert.deepEqual(srv.requests[0].body.metadata, { tags: ['origem:i7ai-embeddings', 'chave:plataforma', 'usuario:user-1'] });
    assert.deepEqual(srv.requests[1].body.metadata.tags, ['origem:i7ai-embeddings', 'chave:plataforma']);
    assert.equal(srv.requests[0].body.model, 'openai/text-embedding-3-small');
  } finally { await srv.close(); }
});

test('direct OpenAI (no EMBEDDING_BASE_URL): no tags, no user, plain model', async () => {
  const srv = await server();
  try {
    await withEnv({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: srv.url }, async () => {
      const service = new EmbeddingService();
      assert.equal(service.model, 'text-embedding-3-small');
      await service.embed(['a'], { tenantId: 'tenant-a', userId: 'u', origem: 'i7ai-embeddings' });
    });
    assert.equal(srv.requests[0].body.user, undefined); assert.equal(srv.requests[0].body.metadata, undefined);
    assert.equal(srv.requests[0].body.model, 'text-embedding-3-small');
  } finally { await srv.close(); }
});

test('model default per mode and EMBEDDING_MODEL override', async () => {
  await withEnv({ EMBEDDING_BASE_URL: 'http://litellm:4000/v1', EMBEDDING_API_KEY: 'k' }, () => assert.equal(new EmbeddingService().model, 'openai/text-embedding-3-small'));
  await withEnv({ EMBEDDING_BASE_URL: 'http://litellm:4000/v1', EMBEDDING_API_KEY: 'k', EMBEDDING_MODEL: 'openai/text-embedding-3-large' }, () => assert.equal(new EmbeddingService().model, 'openai/text-embedding-3-large'));
  await withEnv({ EMBEDDING_API_KEY: 'k' }, () => assert.equal(new EmbeddingService().model, 'text-embedding-3-small'));
});

test('EMBEDDING_VIA_GATEWAY=1 reuses the OmniRouter gateway only when no embedding settings exist', async () => {
  const srv = await server();
  try {
    await withEnv({ OMNIROUTER_BASE_URL: srv.url, OMNIROUTER_API_KEY: 'master' }, () => assert.equal(new EmbeddingService().configured, false));
    await withEnv({ EMBEDDING_VIA_GATEWAY: '1', OMNIROUTER_BASE_URL: srv.url }, () => assert.equal(new EmbeddingService().configured, false));
    await withEnv({ EMBEDDING_VIA_GATEWAY: '1', OMNIROUTER_BASE_URL: srv.url, OMNIROUTER_API_KEY: 'master' }, async () => {
      const service = new EmbeddingService();
      assert.equal(service.configured, true); assert.equal(service.model, 'openai/text-embedding-3-small');
      await service.embed(['a'], { tenantId: 't', origem: 'i7ai-embeddings' });
    });
    assert.equal(srv.requests[0].auth, 'Bearer master'); assert.equal(srv.requests[0].body.user, 't');
    await withEnv({ EMBEDDING_VIA_GATEWAY: '1', EMBEDDING_API_KEY: 'own', OMNIROUTER_BASE_URL: 'http://x/v1', OMNIROUTER_API_KEY: 'master' }, () => assert.equal(new EmbeddingService().model, 'text-embedding-3-small'));
  } finally { await srv.close(); }
});

test('pipeline passes the document tenant to the embedding call', async () => {
  let seen;
  const prisma = {
    document: { findFirst: async () => ({ id: 'd', name: 'a.txt', tenantId: 'tenant-z', storageKey: 'k' }), updateMany: async () => ({}), update: async () => ({}) },
    documentChunk: { deleteMany: async () => ({}), create: async () => ({ id: 'c' }) }, $executeRaw: async () => {},
  };
  prisma.$transaction = async (cb) => cb(prisma);
  const worker = Object.create(DocumentPipelineService.prototype);
  worker.prisma = prisma; worker.s3 = { send: async () => ({ Body: Buffer.from('Texto da lei.') }) }; worker.bucket = 'b';
  worker.embeddings = { model: 'm', embed: async (texts, ctx) => { seen = ctx; return texts.map(() => Array(1536).fill(0.1)); } };
  await worker.process({ data: { documentId: 'd', tenantId: 'tenant-z' }, attemptsMade: 0, opts: { attempts: 3 } });
  assert.deepEqual(seen, { tenantId: 'tenant-z', origem: 'i7ai-embeddings' });
});
