import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { Job, Queue, Worker, UnrecoverableError } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { chunkDocument, DOCUMENT_MAX_BYTES, extractDocumentText } from './document-extractor';

@Injectable()
export class DocumentPipelineService implements OnModuleInit, OnModuleDestroy {
  private readonly connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
  private readonly queue = new Queue('document.process', { connection: this.connection, prefix: process.env.QUEUE_PREFIX || 'bull' });
  private readonly s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000', region: process.env.S3_REGION || 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY ?? 'i7ai', secretAccessKey: process.env.S3_SECRET_KEY ?? 'i7ai_dev_minio' } });
  private readonly bucket = process.env.S3_BUCKET ?? 'i7ai-documents';
  private worker?: Worker;

  constructor(private readonly prisma: PrismaService, private readonly embeddings: EmbeddingService) {
    this.connection.on('error', () => { /* Queue request timeouts report dependency failures. */ });
    this.queue.on('error', () => { /* Queue request timeouts report dependency failures. */ });
  }

  async onModuleInit() {
    this.worker = new Worker('document.process', (job) => this.process(job), { connection: this.connection, concurrency: 2, prefix: process.env.QUEUE_PREFIX || 'bull' });
    this.worker.on('error', () => { /* Queue requests and health checks report Redis failures. */ });
  }

  async onModuleDestroy() {
    await this.worker?.close(); await this.queue.close(); await this.connection.quit();
  }

  async enqueue(documentId: string, tenantId: string) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.queue.add('process-document', { documentId, tenantId }, { jobId: documentId, attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: true }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('A fila de documentos está indisponível.')), 5000); }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
  }

  async process(job: Job<{ documentId: string; tenantId: string }>) {
    const document = await this.prisma.document.findFirst({ where: { id: job.data.documentId, tenantId: job.data.tenantId } });
    if (!document) return;
    await this.prisma.document.updateMany({ where: { id: document.id, tenantId: job.data.tenantId }, data: { status: 'PROCESSING', errorMessage: null } });
    try {
      const object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: document.storageKey }));
      const buffer = await readDocumentBuffer(object.Body);
      let content: string;
      try { content = await extractDocumentText(document.name, buffer); }
      catch (error) { throw new UnrecoverableError(error instanceof Error ? error.message : 'Não foi possível extrair texto do documento.'); }
      const chunks = chunkDocument(content);
      // Private chat content must not be sent to a second provider for indexing.
      const vectors = document.chatOnly ? null : await this.embeddings.embed(chunks, { tenantId: document.tenantId, origem: 'i7ai-embeddings' });
      await this.prisma.$transaction(async (tx) => {
        const stillExists = await tx.document.findFirst({ where: { id: document.id, tenantId: job.data.tenantId } });
        if (!stillExists) return;
        await tx.documentChunk.deleteMany({ where: { documentId: document.id } });
        for (let index = 0; index < chunks.length; index++) {
          const metadata = { pipeline: 'document.process', source: document.name, retrieval: vectors ? 'semantic' : 'literal', ...(vectors ? { embeddingModel: this.embeddings.model } : {}) };
          const chunk = await tx.documentChunk.create({ data: { documentId: document.id, chunkIndex: index, content: chunks[index], metadata } });
          if (vectors) await tx.$executeRaw(Prisma.sql`UPDATE "document_chunks" SET "embedding" = ${JSON.stringify(vectors[index])}::vector WHERE "id" = ${chunk.id}::uuid`);
        }
        await tx.document.update({ where: { id: document.id }, data: { status: 'READY', processedAt: new Date(), errorMessage: null } });
      }, { timeout: 60000 });
    } catch (error) {
      const permanent = error instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts.attempts || 1);
      const message = error instanceof UnrecoverableError ? error.message.slice(0, 1000) : 'Falha ao processar o documento. Verifique armazenamento, fila e configuração do provedor; depois reprocesse.';
      await this.prisma.document.updateMany({ where: { id: document.id, tenantId: job.data.tenantId }, data: { status: permanent ? 'FAILED' : 'PROCESSING', errorMessage: message } });
      throw error;
    }
  }
}

export async function readDocumentBuffer(body: unknown): Promise<Buffer> {
  if (!body) throw new Error('Arquivo ausente no armazenamento.');
  if (Buffer.isBuffer(body)) {
    if (body.length > DOCUMENT_MAX_BYTES) throw new Error('O arquivo armazenado excede o limite de processamento.');
    return body;
  }
  const parts: Buffer[] = []; let size = 0;
  for await (const part of body as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(part); size += buffer.length;
    if (size > DOCUMENT_MAX_BYTES) throw new Error('O arquivo armazenado excede o limite de processamento.');
    parts.push(buffer);
  }
  return Buffer.concat(parts);
}
