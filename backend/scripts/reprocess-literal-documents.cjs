// Re-enqueues READY documents whose chunks were indexed as retrieval 'literal', so they get embeddings once the
// gateway is on. Idempotent: documents already semantic are skipped; the BullMQ jobId is the document id, so a
// document already queued is not duplicated. Prints counts only.
// Usage (backend container): node scripts/reprocess-literal-documents.cjs [--batch 20] [--pause 2000] [--limit N] [--dry-run]
const { PrismaClient } = require('@prisma/client');
const { Queue } = require('bullmq');
const Redis = require('ioredis');

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback; };
const batchSize = Math.min(Math.max(arg('batch', 20), 1), 100);
const pause = Math.max(arg('pause', 2000), 0);
const limit = arg('limit', Infinity);
const dryRun = process.argv.includes('--dry-run');

async function main() {
  if (!process.env.EMBEDDING_API_KEY && !process.env.OPENAI_API_KEY && !process.env.EMBEDDING_BASE_URL && process.env.EMBEDDING_VIA_GATEWAY !== '1') {
    console.log('[reprocess] embeddings nao configurados (defina EMBEDDING_VIA_GATEWAY=1); nada a fazer.'); return;
  }
  const prisma = new PrismaClient();
  const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
  const queue = new Queue('document.process', { connection, prefix: process.env.QUEUE_PREFIX || 'bull' });
  const counts = { encontrados: 0, enfileirados: 0, ignorados: 0 };
  try {
    // chatOnly documents are never embedded on purpose; only READY ones with at least one literal chunk.
    const ids = await prisma.$queryRaw`
      SELECT DISTINCT d."id", d."tenantId" FROM "documents" d JOIN "document_chunks" dc ON dc."documentId" = d."id"
      WHERE d."status" = 'READY' AND d."chatOnly" = false AND dc."metadata"->>'retrieval' = 'literal' ORDER BY d."id"`;
    counts.encontrados = ids.length;
    const todo = ids.slice(0, limit);
    for (let i = 0; i < todo.length; i += batchSize) {
      for (const doc of todo.slice(i, i + batchSize)) {
        if (dryRun) { counts.ignorados++; continue; }
        // Same guard as KnowledgeService.reprocess: only flip READY -> PROCESSING; anything else is being handled elsewhere.
        const flipped = await prisma.document.updateMany({ where: { id: doc.id, tenantId: doc.tenantId, status: 'READY' }, data: { status: 'PROCESSING', errorMessage: null } });
        if (!flipped.count) { counts.ignorados++; continue; }
        try {
          await queue.add('process-document', { documentId: doc.id, tenantId: doc.tenantId }, { jobId: doc.id, attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: true });
          counts.enfileirados++;
        } catch {
          await prisma.document.updateMany({ where: { id: doc.id, tenantId: doc.tenantId, status: 'PROCESSING' }, data: { status: 'READY' } });
          counts.ignorados++;
        }
      }
      console.log(`[reprocess] lote ${Math.floor(i / batchSize) + 1}: enfileirados ${counts.enfileirados}/${todo.length}`);
      if (pause && i + batchSize < todo.length) await new Promise((resolve) => setTimeout(resolve, pause));
    }
    console.log(`[reprocess] encontrados ${counts.encontrados}; enfileirados ${counts.enfileirados}; ignorados ${counts.ignorados}${dryRun ? ' (dry-run)' : ''}`);
  } finally { await queue.close(); await connection.quit(); await prisma.$disconnect(); }
}
main().catch(() => { console.error('[reprocess] falhou (banco ou fila indisponivel).'); process.exit(1); });
