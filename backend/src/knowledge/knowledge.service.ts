import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException, StreamableFile } from '@nestjs/common';
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { Document, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentPipelineService, readDocumentBuffer } from './document-pipeline.service';
import { CreateKnowledgeBaseDto, UpdateKnowledgeBaseDto } from './dto/knowledge.dto';
import { DocumentUpload } from './document-extractor';
import { validateKnowledgeUpload } from './knowledge-image';
import { assertLicenseCapacity, assertStorageCapacity } from '../catalog/license-policy';
import { CHAT_ATTACHMENT_MAX_COUNT, CHAT_ATTACHMENT_TEXT_LIMIT, validateChatAttachment } from './chat-attachment-validation';

export function publicChatAttachment(document: Pick<Document, 'id' | 'name' | 'mimeType' | 'sizeBytes' | 'status' | 'errorMessage'>) {
  return { id: document.id, name: document.name, mimeType: document.mimeType, sizeBytes: document.sizeBytes.toString(), status: document.status, errorMessage: document.errorMessage ?? null };
}

@Injectable()
export class KnowledgeService implements OnModuleInit, OnModuleDestroy {
  private readonly s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000', region: process.env.S3_REGION || 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY ?? 'i7ai', secretAccessKey: process.env.S3_SECRET_KEY ?? 'i7ai_dev_minio' } });
  private readonly bucket = process.env.S3_BUCKET ?? 'i7ai-documents';
  private cleanupTimer?: NodeJS.Timeout;
  private cleanupRun?: Promise<unknown>;
  private stopping = false;

  constructor(private readonly prisma: PrismaService, private readonly pipeline: DocumentPipelineService) {}

  onModuleInit() { this.scheduleCleanup(60000); }
  private scheduleCleanup(delay: number) {
    if (this.stopping) return;
    this.cleanupTimer = setTimeout(() => {
      this.cleanupRun = this.cleanupOrphanChatAttachments().catch(() => undefined).finally(() => this.scheduleCleanup(3600000));
    }, delay);
    this.cleanupTimer.unref();
  }
  async onModuleDestroy() { this.stopping = true; clearTimeout(this.cleanupTimer); await this.cleanupRun; this.s3.destroy(); }

  private async ensureBucket() {
    try { await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket })); }
    catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw new ServiceUnavailableException('O armazenamento de documentos está indisponível.');
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async uploadDocument(tenantId: string, file?: DocumentUpload, knowledgeBaseId?: string, userId?: string) {
    const mimeType = validateKnowledgeUpload(file);
    if (knowledgeBaseId) await this.requireBase(tenantId, knowledgeBaseId);
    return this.storeDocument(tenantId, file!, mimeType, file!.originalname.slice(0, 255), knowledgeBaseId, userId);
  }

  async uploadChatAttachment(tenantId: string, userId: string, file?: DocumentUpload) {
    const validated = await validateChatAttachment(file);
    const document = await this.storeDocument(tenantId, file!, validated.mimeType, validated.name, undefined, userId, true, validated.image);
    return publicChatAttachment(document as unknown as Document);
  }

  private async storeDocument(tenantId: string, file: DocumentUpload, mimeType: string, name: string, knowledgeBaseId?: string, userId?: string, chatOnly = false, image = false) {
    const selectedFile = file;
    const storageKey = tenantId + '/' + randomUUID() + '-' + name.replace(/[^a-zA-Z0-9._-]/g, '_');
    // Reserve storage under the same tenant lock used by license changes. The row also
    // makes simultaneous uploads count against the allowance before any S3 request.
    const document = await this.prisma.$transaction(async (tx) => {
      await assertStorageCapacity(tx, tenantId, BigInt(selectedFile.buffer.length));
      if (chatOnly && (!userId || !await tx.user.findFirst({ where: { id: userId, tenantId, status: 'ACTIVE' }, select: { id: true } }))) throw new NotFoundException('Usuário não encontrado para este anexo.');
      if (knowledgeBaseId && !await tx.knowledgeBase.findFirst({ where: { id: knowledgeBaseId, tenantId, status: 'ACTIVE' } })) {
        throw new BadRequestException('A base de conhecimento está indisponível para esta prefeitura.');
      }
      return tx.document.create({ data: { tenantId, knowledgeBaseId, name, mimeType, storageKey, sizeBytes: BigInt(selectedFile.buffer.length), status: 'UPLOADED', ...(chatOnly ? { chatOnly: true, ownerUserId: userId } : {}) } });
    });
    try {
      await this.ensureBucket();
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: storageKey, Body: selectedFile.buffer, ContentType: mimeType }));
    } catch {
      // Release the reservation if storage fails, including an interrupted partial upload.
      await this.prisma.document.deleteMany({ where: { id: document.id, tenantId } });
      try { await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey })); } catch { /* Cleanup can be retried by storage lifecycle policy. */ }
      throw new ServiceUnavailableException('Não foi possível salvar o arquivo. Verifique o armazenamento de documentos.');
    }
    if (image) {
      const ready = await this.prisma.document.update({ where: { id: document.id }, data: { status: 'READY', processedAt: new Date(), errorMessage: null } });
      await this.audit(tenantId, userId, 'chat_attachment.uploaded', 'document', document.id);
      return { ...document, ...ready, sizeBytes: document.sizeBytes.toString() };
    }
    await this.prisma.document.update({ where: { id: document.id }, data: { status: 'PROCESSING' } });
    try { await this.pipeline.enqueue(document.id, tenantId); }
    catch {
      await this.prisma.document.update({ where: { id: document.id }, data: { status: 'FAILED', errorMessage: 'Fila indisponível. Use reprocessar quando o Redis estiver disponível.' } });
      if (chatOnly) {
        try {
          await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }));
          await this.prisma.document.deleteMany({ where: { id: document.id, tenantId, chatOnly: true, ownerUserId: userId } });
        } catch { /* Orphan cleanup releases the remaining private file after storage recovers. */ }
        throw new ServiceUnavailableException('A fila de processamento de anexos está indisponível. Tente enviar novamente mais tarde.');
      }
      throw new ServiceUnavailableException('O arquivo foi salvo, mas a fila está indisponível. Ele aparece como falha na lista e pode ser reprocessado.');
    }
    await this.audit(tenantId, userId, chatOnly ? 'chat_attachment.uploaded' : 'document.uploaded', 'document', document.id);
    return { ...document, status: 'PROCESSING', sizeBytes: document.sizeBytes.toString() };
  }
  listBases(tenantId: string) {
    return this.prisma.knowledgeBase.findMany({ where: { tenantId }, include: { _count: { select: { documents: true, agents: true } } }, orderBy: { updatedAt: 'desc' } });
  }

  async createBase(tenantId: string, input: CreateKnowledgeBaseDto, userId?: string) {
    if (!input.name.trim()) throw new BadRequestException('Informe o nome da base.');
    const base = await this.prisma.$transaction(async (tx) => {
      await assertLicenseCapacity(tx, tenantId, 'knowledgeBases');
      return tx.knowledgeBase.create({ data: { tenantId, name: input.name.trim(), description: input.description } });
    });
    await this.audit(tenantId, userId, 'knowledge_base.created', 'knowledge_base', base.id);
    return base;
  }

  async updateBase(tenantId: string, id: string, input: UpdateKnowledgeBaseDto, userId?: string) {
    await this.requireBase(tenantId, id, false);
    if (input.name !== undefined && !input.name.trim()) throw new BadRequestException('Informe o nome da base.');
    const base = await this.prisma.knowledgeBase.update({ where: { id }, data: { ...input, ...(input.name ? { name: input.name.trim() } : {}) } });
    await this.audit(tenantId, userId, 'knowledge_base.updated', 'knowledge_base', id);
    return base;
  }

  async listDocuments(tenantId: string, knowledgeBaseId?: string) {
    if (knowledgeBaseId) await this.requireBase(tenantId, knowledgeBaseId, false);
    const documents = await this.prisma.document.findMany({ where: { tenantId, chatOnly: false, ...(knowledgeBaseId ? { knowledgeBaseId } : {}) }, include: { knowledgeBase: true, _count: { select: { chunks: true } } }, orderBy: { createdAt: 'desc' } });
    return documents.map((document) => ({ ...document, sizeBytes: document.sizeBytes.toString() }));
  }

  async assignBase(tenantId: string, id: string, knowledgeBaseId?: string | null, userId?: string) {
    await this.requireDocument(tenantId, id);
    if (knowledgeBaseId) await this.requireBase(tenantId, knowledgeBaseId);
    if (knowledgeBaseId === undefined) throw new BadRequestException('Informe knowledgeBaseId ou null para remover o vínculo.');
    const document = await this.prisma.document.update({ where: { id }, data: { knowledgeBaseId } });
    await this.audit(tenantId, userId, 'document.updated', 'document', id);
    return { ...document, sizeBytes: document.sizeBytes.toString() };
  }

  async download(tenantId: string, id: string) {
    const document = await this.requireDocument(tenantId, id);
    try {
      const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: document.storageKey }));
      const content = await readDocumentBuffer(response.Body);
      return new StreamableFile(content, { type: document.mimeType, disposition: "attachment; filename*=UTF-8''" + encodeURIComponent(document.name), length: content.length });
    } catch { throw new ServiceUnavailableException('Não foi possível baixar o arquivo do armazenamento.'); }
  }

  async removeDocument(tenantId: string, id: string, userId?: string) {
    const document = await this.requireDocument(tenantId, id);
    if (document.status === 'PROCESSING' || (document.status === 'UPLOADED' && Date.now() - document.createdAt.getTime() < 10 * 60 * 1000)) throw new ConflictException('Aguarde o envio e o processamento terminarem antes de excluir o documento.');
    try { await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: document.storageKey })); }
    catch { throw new ServiceUnavailableException('Não foi possível excluir o arquivo do armazenamento.'); }
    await this.prisma.document.deleteMany({ where: { id, tenantId } });
    await this.audit(tenantId, userId, 'document.deleted', 'document', id);
    return { id, deleted: true };
  }

  async reprocess(tenantId: string, id: string, userId?: string) {
    const document = await this.requireDocument(tenantId, id);
    if (document.status === 'PROCESSING' || (document.status === 'UPLOADED' && Date.now() - document.createdAt.getTime() < 10 * 60 * 1000)) throw new ConflictException('Este documento está sendo enviado ou processado.');
    await this.prisma.document.update({ where: { id }, data: { status: 'PROCESSING', errorMessage: null } });
    try { await this.pipeline.enqueue(id, tenantId); }
    catch {
      await this.prisma.document.update({ where: { id }, data: { status: 'FAILED', errorMessage: 'Fila indisponível. Tente reprocessar novamente.' } });
      throw new ServiceUnavailableException('A fila de processamento está indisponível.');
    }
    await this.audit(tenantId, userId, 'document.reprocessed', 'document', id);
    return { id, status: 'PROCESSING' };
  }

  private async requireChatAttachment(tenantId: string, userId: string, id: string) {
    const document = await this.prisma.document.findFirst({ where: { id, tenantId, ownerUserId: userId, chatOnly: true } });
    if (!document) throw new NotFoundException('Anexo não encontrado.');
    return document;
  }

  async getChatAttachment(tenantId: string, userId: string, id: string) {
    return publicChatAttachment(await this.requireChatAttachment(tenantId, userId, id));
  }

  async downloadChatAttachment(tenantId: string, userId: string, id: string) {
    const document = await this.requireChatAttachment(tenantId, userId, id);
    try {
      const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: document.storageKey }));
      const content = await readDocumentBuffer(response.Body);
      return new StreamableFile(content, { type: document.mimeType, disposition: "attachment; filename*=UTF-8''" + encodeURIComponent(document.name), length: content.length });
    } catch { throw new ServiceUnavailableException('Não foi possível baixar o anexo do armazenamento.'); }
  }

  async removeChatAttachment(tenantId: string, userId: string, id: string) {
    await this.requireChatAttachment(tenantId, userId, id);
    await this.prisma.$transaction(async tx => {
      // Serialize deletion against attachment links created by a chat transaction.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM documents WHERE id = ${id}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`);
      const document = await tx.document.findFirst({ where: { id, tenantId, ownerUserId: userId, chatOnly: true }, include: { _count: { select: { messageAttachments: true } } } });
      if (!document) throw new NotFoundException('Anexo não encontrado.');
      if (document._count.messageAttachments) throw new ConflictException('Este anexo já faz parte do histórico de uma conversa.');
      if (['PROCESSING', 'UPLOADED'].includes(document.status)) throw new ConflictException('Aguarde o envio e o processamento terminarem antes de remover o anexo.');
      try { await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: document.storageKey })); }
      catch { throw new ServiceUnavailableException('Não foi possível remover o anexo do armazenamento.'); }
      await tx.document.deleteMany({ where: { id, tenantId, ownerUserId: userId, chatOnly: true } });
      await tx.auditLog.create({ data: { tenantId, userId, event: 'chat_attachment.deleted', resource: 'document', resourceId: id } });
    });
    return { id, deleted: true };
  }

  async prepareChatAttachments(tenantId: string, userId: string, ids: string[] = []) {
    if (!Array.isArray(ids) || ids.length > CHAT_ATTACHMENT_MAX_COUNT || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id)) throw new BadRequestException('Envie até cinco anexos diferentes por mensagem.');
    if (!ids.length) return { documents: [], text: '', images: [] };
    const records = await this.prisma.document.findMany({
      where: { id: { in: ids }, tenantId, ownerUserId: userId, chatOnly: true },
      include: { chunks: { orderBy: { chunkIndex: 'asc' }, take: 48 }, _count: { select: { chunks: true } } },
    });
    if (records.length !== ids.length) throw new NotFoundException('Um ou mais anexos não foram encontrados para este usuário.');
    const documents = ids.map(id => records.find(document => document.id === id)!);
    for (const document of documents) {
      if (document.status !== 'READY') throw new ConflictException(document.status === 'FAILED' ? `O anexo ${document.name} falhou no processamento. Remova-o e envie um arquivo válido.` : `O anexo ${document.name} ainda está sendo processado. Aguarde antes de enviar.`);
    }
    const images: { id: string; name: string; mimeType: string; dataUrl: string }[] = [];
    const parts: string[] = [];
    const truncationNotice = '[Aviso: o conteúdo dos anexos foi limitado a 48.000 caracteres. A análise cobre apenas os trechos enviados; divida os arquivos para uma análise completa.]';
    let remaining = CHAT_ATTACHMENT_TEXT_LIMIT - truncationNotice.length - 2;
    let truncated = false;
    for (const document of documents) {
      if (document.mimeType.startsWith('image/')) {
        let buffer: Buffer;
        try {
          const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: document.storageKey }));
          buffer = await readDocumentBuffer(response.Body);
        } catch { throw new ServiceUnavailableException('Não foi possível recuperar a imagem anexada.'); }
        // Revalidate stored bytes before exposing them to the provider payload.
        await validateChatAttachment({ originalname: document.name, mimetype: document.mimeType, size: buffer.length, buffer });
        images.push({ id: document.id, name: document.name, mimeType: document.mimeType, dataUrl: `data:${document.mimeType};base64,${buffer.toString('base64')}` });
      } else {
        if (!document.chunks.length) throw new ConflictException(`O anexo ${document.name} não possui conteúdo processado.`);
        // The existing extractor trims chunks. Their original offsets cannot be
        // recovered safely from repetitive text, so retain each selected chunk.
        const content = document.chunks.map(chunk => `[Trecho ${chunk.chunkIndex + 1}]\n${chunk.content}`).join('\n\n');
        const header = `[Anexo: ${document.name}]\n[Os trechos consecutivos podem repetir até 150 caracteres. A sobreposição não representa dados adicionais.]\n`;
        const available = Math.max(0, remaining - header.length - 2);
        const selected = content.slice(0, available);
        truncated ||= selected.length < content.length || document._count.chunks > document.chunks.length;
        if (selected) { parts.push(header + selected); remaining -= header.length + selected.length + 2; }
        else truncated = true;
      }
    }
    if (truncated) parts.push(truncationNotice);
    return { documents: documents.map(publicChatAttachment), text: parts.join('\n\n'), images };
  }

  async cleanupOrphanChatAttachments(now = new Date()) {
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const rows = await this.prisma.document.findMany({ where: { chatOnly: true, createdAt: { lt: cutoff }, messageAttachments: { none: {} } }, select: { id: true, tenantId: true }, orderBy: { createdAt: 'asc' }, take: 100 });
    let deleted = 0;
    for (const row of rows) {
      if (this.stopping) break;
      try {
        deleted += await this.prisma.$transaction(async tx => {
          await tx.$queryRaw(Prisma.sql`SELECT id FROM documents WHERE id = ${row.id}::uuid AND "tenantId" = ${row.tenantId}::uuid FOR UPDATE`);
          const document = await tx.document.findFirst({ where: { id: row.id, tenantId: row.tenantId, chatOnly: true, createdAt: { lt: cutoff }, messageAttachments: { none: {} } } });
          if (!document) return 0;
          await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: document.storageKey }));
          return (await tx.document.deleteMany({ where: { id: row.id, tenantId: row.tenantId, chatOnly: true, messageAttachments: { none: {} } } })).count;
        });
      } catch { /* Keep the row and storage allowance for a later retry. */ }
    }
    return { deleted };
  }

  private async requireBase(tenantId: string, id: string, active = true) {
    const base = await this.prisma.knowledgeBase.findFirst({ where: { id, tenantId } });
    if (!base) throw new NotFoundException('Base de conhecimento não encontrada.');
    if (active && base.status !== 'ACTIVE') throw new BadRequestException('Esta base de conhecimento está inativa.');
    return base;
  }

  private async requireDocument(tenantId: string, id: string) {
    const document = await this.prisma.document.findFirst({ where: { id, tenantId, chatOnly: false } });
    if (!document) throw new NotFoundException('Documento não encontrado.');
    return document;
  }

  private audit(tenantId: string, userId: string | undefined, event: string, resource: string, resourceId: string) {
    return this.prisma.auditLog.create({ data: { tenantId, userId, event, resource, resourceId } });
  }
}
