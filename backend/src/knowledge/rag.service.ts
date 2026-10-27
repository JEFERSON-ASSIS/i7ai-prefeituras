import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';

export type RagSource = { id: string; content: string; documentName: string; documentId: string; knowledgeBaseId: string; chunkIndex: number; score?: number; retrieval: 'semantic' | 'literal' };

const STOP_WORDS = new Set('que com para uma como por dos das nos nas aos ao os as um de da do em e o a eu me se qual quais quando onde quero preciso sobre esse essa este esta pode poderia favor'.split(' '));
export function searchTerms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase('pt-BR').match(/[\p{L}\p{N}]{3,}/gu) || [])].filter((term) => !STOP_WORDS.has(term)).slice(0, 16);
}

@Injectable()
export class RagService {
  constructor(private readonly prisma: PrismaService, private readonly embeddings: EmbeddingService) {}

  async searchForAgent(tenantId: string, agentId: string, query: string, limit = 6, userId?: string): Promise<RagSource[]> {
    const agent = await this.prisma.agent.findFirst({ where: { id: agentId, tenantId }, select: { knowledgeBases: { select: { knowledgeBase: { select: { id: true, tenantId: true, status: true } } } } } });
    if (!agent) throw new NotFoundException('Agente não encontrado.');
    const bases = agent.knowledgeBases.map((link) => link.knowledgeBase).filter((base) => base.tenantId === tenantId && base.status === 'ACTIVE').map((base) => base.id);
    // An unconfigured agent must never gain access to every document in its tenant.
    if (!bases.length) return [];
    return this.search(tenantId, query, limit, bases, userId);
  }

  async search(tenantId: string, query: string, limit = 8, knowledgeBaseIds?: string[], userId?: string): Promise<RagSource[]> {
    if (!query.trim() || knowledgeBaseIds?.length === 0) return [];
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 20) : 8;
    const baseFilter = knowledgeBaseIds ? Prisma.sql`AND d."knowledgeBaseId" IN (${Prisma.join(knowledgeBaseIds.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty;
    let semantic: RagSource[] = [];
    if (this.embeddings.configured) {
      try {
        const vectors = await this.embeddings.embed([query.slice(0, 8000)], { tenantId, userId, origem: 'i7ai-embeddings' });
        if (vectors) {
          semantic = await this.prisma.$queryRaw<RagSource[]>(Prisma.sql`
            SELECT dc."id", dc."content", dc."documentId", dc."chunkIndex", d."knowledgeBaseId", d."name" AS "documentName",
              1 - (dc."embedding" <=> ${JSON.stringify(vectors[0])}::vector) AS "score", 'semantic' AS "retrieval"
            FROM "document_chunks" dc
            JOIN "documents" d ON d."id" = dc."documentId"
            JOIN "knowledge_bases" kb ON kb."id" = d."knowledgeBaseId"
            WHERE d."tenantId" = ${tenantId}::uuid AND kb."tenantId" = ${tenantId}::uuid
              AND d."chatOnly" = false AND d."status" = 'READY' AND kb."status" = 'ACTIVE' AND dc."embedding" IS NOT NULL
              AND dc."metadata"->>'embeddingModel' = ${this.embeddings.model} ${baseFilter}
              AND 1 - (dc."embedding" <=> ${JSON.stringify(vectors[0])}::vector) >= 0.2
            ORDER BY dc."embedding" <=> ${JSON.stringify(vectors[0])}::vector, dc."id"
            LIMIT ${safeLimit}
          `);
        }
      } catch {
        // The documented literal fallback still works when the embedding provider is unavailable.
        semantic = [];
      }
    }
    if (semantic.length >= safeLimit) return semantic;
    const terms = searchTerms(query);
    if (!terms.length) return semantic;
    const matches = terms.map((term) => Prisma.sql`dc."content" ILIKE ${'%' + term + '%'}`);
    const score = Prisma.join(matches.map((match) => Prisma.sql`CASE WHEN ${match} THEN 1 ELSE 0 END`), ' + ');
    const literal = await this.prisma.$queryRaw<RagSource[]>(Prisma.sql`
      SELECT dc."id", dc."content", dc."documentId", dc."chunkIndex", d."knowledgeBaseId", d."name" AS "documentName",
        (${score})::float / ${terms.length} AS "score", 'literal' AS "retrieval"
      FROM "document_chunks" dc
      JOIN "documents" d ON d."id" = dc."documentId"
      JOIN "knowledge_bases" kb ON kb."id" = d."knowledgeBaseId"
      WHERE d."tenantId" = ${tenantId}::uuid AND kb."tenantId" = ${tenantId}::uuid
        AND d."chatOnly" = false AND d."status" = 'READY' AND kb."status" = 'ACTIVE' ${baseFilter}
        AND (${Prisma.join(matches, ' OR ')})
      ORDER BY (${score}) DESC, d."createdAt" DESC, dc."chunkIndex", dc."id"
      LIMIT ${safeLimit}
    `);
    const ids = new Set(semantic.map((item) => item.id));
    return [...semantic, ...literal.filter((item) => !ids.has(item.id))].slice(0, safeLimit);
  }
}
