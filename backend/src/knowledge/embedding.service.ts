import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import OpenAI from 'openai';

export type EmbeddingContext = { tenantId: string; userId?: string; origem: 'i7ai-embeddings' };

@Injectable()
export class EmbeddingService {
  // Where embeddings go: LiteLLM gateway (EMBEDDING_BASE_URL, or the OmniRouter one with EMBEDDING_VIA_GATEWAY=1) or OpenAI direct.
  private route(): { apiKey?: string; baseURL?: string; gateway: boolean } {
    const baseURL = process.env.EMBEDDING_BASE_URL || undefined;
    const apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || undefined;
    if (baseURL) return { apiKey, baseURL, gateway: true };
    if (!process.env.EMBEDDING_API_KEY && process.env.EMBEDDING_VIA_GATEWAY === '1' && process.env.OMNIROUTER_BASE_URL && process.env.OMNIROUTER_API_KEY) {
      return { apiKey: process.env.OMNIROUTER_API_KEY, baseURL: process.env.OMNIROUTER_BASE_URL, gateway: true };
    }
    return { apiKey, baseURL: process.env.OPENAI_BASE_URL || undefined, gateway: false };
  }

  get model() { return process.env.EMBEDDING_MODEL || (this.route().gateway ? 'openai/text-embedding-3-small' : 'text-embedding-3-small'); }
  get configured() { return Boolean(this.route().apiKey); }

  async embed(texts: string[], ctx?: EmbeddingContext): Promise<number[][] | null> {
    const route = this.route();
    if (!route.apiKey) return null;
    const client = new OpenAI({ apiKey: route.apiKey, baseURL: route.baseURL, timeout: 60000, maxRetries: 1 });
    // Same shape as chat calls: `user` = prefeitura and ids-only tags, so the gateway attributes the cost. Never sent to OpenAI direct.
    const attribution = route.gateway && ctx
      ? { user: ctx.tenantId, metadata: { tags: ['origem:' + ctx.origem, 'chave:plataforma', ...(ctx.userId ? ['usuario:' + ctx.userId] : [])] } }
      : {};
    try {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += 64) {
        const batch = texts.slice(start, start + 64);
        const response = await client.embeddings.create({ model: this.model, input: batch, dimensions: 1536, ...attribution } as OpenAI.EmbeddingCreateParams);
        const ordered = [...response.data].sort((a, b) => a.index - b.index);
        if (ordered.length !== batch.length || ordered.some((item) => item.embedding.length !== 1536 || item.embedding.some((n) => !Number.isFinite(n)))) {
          throw new Error('Invalid embedding dimensions');
        }
        vectors.push(...ordered.map((item) => item.embedding));
      }
      return vectors;
    } catch {
      throw new ServiceUnavailableException('O provedor de embeddings falhou. Verifique a chave, o modelo e a conexão; depois reprocesse o documento.');
    }
  }
}
