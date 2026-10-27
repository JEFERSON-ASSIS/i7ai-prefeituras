// Pure savings formulas of the Central de IA (Entrega 4, Task 8). No I/O here. Prices are USD per million tokens,
// the current ones of `ai_models`. A figure that cannot be measured is null, never 0.
import { calculateUsageCost } from '../ai/ai-quota.service';

export const price = (value: unknown) => Number(value) || 0;
const round = (value: number) => Number(value.toFixed(6));

export type ModelPrices = {
  slug: string; inputPrice: unknown; outputPrice: unknown; cachedInputPrice?: unknown; cacheWriteInputPrice?: unknown;
};

/** Prices as the cost path bills them: missing cache prices fall back to the input price (Decision 5). */
export function prices(model: ModelPrices) {
  const input = price(model.inputPrice);
  return {
    input,
    output: price(model.outputPrice),
    cached: model.cachedInputPrice === null || model.cachedInputPrice === undefined ? input : price(model.cachedInputPrice),
    write: model.cacheWriteInputPrice === null || model.cacheWriteInputPrice === undefined ? input : price(model.cacheWriteInputPrice),
  };
}

/** One `ai_usage` row with its model's current prices (null when the model is gone). */
export type UsageRow = {
  tenantId: string; agentId: string | null; userId: string | null; modelId: string | null; model: ModelPrices | null;
  inputTokens: number; outputTokens: number; cost: unknown; cachedInputTokens: number; cacheWriteInputTokens: number;
  cacheHit: boolean; historySavedTokens: number; lowDetailImages: number; highDetailImages: number;
  requestHash: string | null; kind: string; truncated: boolean; createdAt: Date;
};

export type ModelSwapEvent = { agentId: string | null; kind: string; createdAt: Date; fromModelId: string | null; toModelId: string | null; from: ModelPrices | null };

function costAt(row: UsageRow, model: ModelPrices) {
  const p = prices(model);
  return calculateUsageCost(row.inputTokens, row.outputTokens, p.input, p.output, row.cachedInputTokens, p.cached, row.cacheWriteInputTokens, p.write);
}

/**
 * Prompt cache, measured: read tokens priced at (input − cached) minus written tokens at (write − input).
 * Includes OpenAI's automatic cache (the label says so).
 */
export function promptCacheSavings(rows: UsageRow[]): number {
  let total = 0;
  for (const row of rows) {
    if (!row.model) continue;
    const p = prices(row.model);
    total += row.cachedInputTokens * (p.input - p.cached) - row.cacheWriteInputTokens * (p.write - p.input);
  }
  return round(total / 1_000_000);
}

const FIVE_MINUTES = 5 * 60 * 1000;

/**
 * Prompt cache, estimated for agents with the cache off (`prefixTokensByAgent` only lists those, prefix ≥ 1024):
 * a call less than 5 minutes after the previous one of the same agent would read the prefix, the others would
 * write it (the write surcharge only exists for `anthropic/`). Null when no agent qualifies.
 */
export function promptCacheEstimate(rows: UsageRow[], prefixTokensByAgent: Record<string, number>): number | null {
  const byAgent = new Map<string, UsageRow[]>();
  for (const row of rows) {
    if (!row.agentId || !row.model || row.kind !== 'resposta' || row.cacheHit) continue;
    const prefix = prefixTokensByAgent[row.agentId];
    if (!prefix || prefix < 1024) continue;
    byAgent.set(row.agentId, [...(byAgent.get(row.agentId) ?? []), row]);
  }
  if (!byAgent.size) return null;
  let total = 0;
  for (const [agentId, list] of byAgent) {
    const prefix = prefixTokensByAgent[agentId];
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    list.forEach((row, index) => {
      const p = prices(row.model as ModelPrices);
      const hit = index > 0 && row.createdAt.getTime() - list[index - 1].createdAt.getTime() < FIVE_MINUTES;
      if (hit) total += prefix * (p.input - p.cached);
      else if ((row.model as ModelPrices).slug.startsWith('anthropic/')) total -= prefix * (p.write - p.input);
    });
  }
  return round(total / 1_000_000);
}

/** Exact cache, measured: what each hit (billed 0) would have cost at its model's prices. */
export function exactCacheSavings(rows: UsageRow[]): number {
  let total = 0;
  for (const row of rows) if (row.cacheHit && row.model) total += costAt(row, row.model);
  return round(total);
}

/**
 * Exact cache, estimated: cost of the misses whose request hash repeats an earlier request of the same prefeitura
 * within the TTL. The TTL is anchored on the miss that would have written the entry (a read never extends it), so
 * a repeat after expiry becomes the new anchor.
 */
export function exactCacheEstimate(rows: UsageRow[], ttlSeconds: number): number {
  const anchors = new Map<string, number>();
  let total = 0;
  for (const row of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (!row.requestHash) continue;
    const key = row.tenantId + ':' + row.requestHash;
    const at = row.createdAt.getTime();
    const anchor = anchors.get(key);
    if (row.cacheHit) continue;
    if (anchor !== undefined && at - anchor <= ttlSeconds * 1000) total += price(row.cost);
    else anchors.set(key, at);
  }
  return round(total);
}

/** History summary, measured: saved history tokens of the answers at their input price, minus what the summaries cost. */
export function summarySavings(rows: UsageRow[]): number {
  let total = 0;
  for (const row of rows) {
    if (row.kind === 'resumo') total -= price(row.cost);
    else if (row.historySavedTokens > 0 && row.model) total += row.historySavedTokens * prices(row.model).input / 1_000_000;
  }
  return round(total);
}

/** Message sizes only: the text never leaves the database for this figure. */
export type SummaryMessage = { role: string; chars: number; bytes: number; inPeriod: boolean };
export type SummaryConversation = { inputPrice: unknown; messages: SummaryMessage[] };

/** Assumed compression of the summary (the label says "estimativa"). */
export const SUMMARY_COMPRESSION = 0.75;

/** Same window as `historyWindow` (last 40 messages, newest first up to 48,000 characters), on sizes. */
function windowBySize(history: SummaryMessage[]): SummaryMessage[] {
  let size = 0;
  return history.slice(-40).reverse().filter(item => {
    if (!['user', 'assistant'].includes(item.role)) return false;
    size += item.chars;
    return size <= 48000;
  }).reverse();
}

/**
 * History summary, estimated for conversations with it off: for each answer in the period past position `n`, the
 * tokens (`estimateTokens`: bytes / 4) of the history sent today older than the `n/2` most recent, × 0.75 × input price.
 */
export function summaryEstimate(conversations: SummaryConversation[], n: number): number {
  const keep = Math.floor(n / 2);
  let total = 0;
  for (const conversation of conversations) {
    const messages = conversation.messages.filter(item => item.role === 'user' || item.role === 'assistant');
    const input = price(conversation.inputPrice);
    messages.forEach((message, index) => {
      if (message.role !== 'assistant' || !message.inPeriod || index + 1 <= n) return;
      // History of that answer: everything before the user message that triggered it.
      const history = windowBySize(messages.slice(0, Math.max(0, index - 1)));
      const older = history.slice(0, Math.max(0, history.length - keep));
      const tokens = older.reduce((sum, item) => sum + Math.ceil(item.bytes / 4), 0);
      total += tokens * SUMMARY_COMPRESSION * input / 1_000_000;
    });
  }
  return round(total);
}

/** Tokens saved per image by `detail: 'low'`: 1024 px in `auto` (765) versus `low` (85). An approximation. */
export const IMAGE_TOKENS_SAVED = 765 - 85;

/** Images in low detail, only for `openai/` models (others do not reduce by this parameter). */
export function imageSavings(rows: UsageRow[]): { real: number; estimate: number } {
  let real = 0; let estimate = 0;
  for (const row of rows) {
    if (!row.model?.slug.startsWith('openai/')) continue;
    const input = prices(row.model).input;
    real += row.lowDetailImages * IMAGE_TOKENS_SAVED * input;
    estimate += row.highDetailImages * IMAGE_TOKENS_SAVED * input;
  }
  return { real: round(real / 1_000_000), estimate: round(estimate / 1_000_000) };
}

/**
 * Model swaps made from the Central: each agent row after a TROCA_MODELO (and before that agent's next swap) that
 * used the new model, priced at the old model minus the new one; input, cache and output count, never below 0 per row.
 */
export function modelSwapSavings(rows: UsageRow[], events: ModelSwapEvent[]): number {
  const swaps = events.filter(event => event.kind === 'TROCA_MODELO' && event.agentId && event.toModelId && event.from)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const all = events.filter(event => event.kind === 'TROCA_MODELO' && event.agentId);
  let total = 0;
  for (const event of swaps) {
    const start = event.createdAt.getTime();
    const next = all.filter(other => other.agentId === event.agentId && other.createdAt.getTime() > start)
      .reduce((min, other) => Math.min(min, other.createdAt.getTime()), Infinity);
    for (const row of rows) {
      const at = row.createdAt.getTime();
      if (row.agentId !== event.agentId || row.modelId !== event.toModelId || !row.model || at <= start || at >= next) continue;
      total += Math.max(0, costAt(row, event.from as ModelPrices) - costAt(row, row.model));
    }
  }
  return round(total);
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))];
}
