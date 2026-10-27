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

const byTime = (rows: UsageRow[]) => [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

// Every figure below is an accumulator fed one row at a time in (createdAt, id) order, so the endpoint can stream
// `ai_usage` in batches and keep only per-key state. The functions taking `rows` are the same accumulators over a
// whole list (used by the tests and as the reference).

/**
 * Prompt cache, measured: read tokens priced at (input − cached) minus written tokens at (write − input).
 * Includes OpenAI's automatic cache (the label says so). Exact-cache hits carry no provider tokens and are skipped.
 */
export class PromptCacheSavings {
  private total = 0;
  add(row: UsageRow) {
    if (!row.model || row.cacheHit) return;
    const p = prices(row.model);
    this.total += row.cachedInputTokens * (p.input - p.cached) - row.cacheWriteInputTokens * (p.write - p.input);
  }
  value() { return round(this.total / 1_000_000); }
}
export function promptCacheSavings(rows: UsageRow[]): number {
  const acc = new PromptCacheSavings(); rows.forEach(row => acc.add(row)); return acc.value();
}

const FIVE_MINUTES = 5 * 60 * 1000;
export const PREFIX_MIN_TOKENS = 1024;

/**
 * Prompt cache, estimated for agents with the cache off (`prefixTokensByAgent` only lists those, prefix ≥ 1024):
 * a call less than 5 minutes after the previous one of the same agent would read the prefix, the others would
 * write it (the write surcharge only exists for `anthropic/`). Null when no agent qualifies. The prefix is constant
 * per agent, so each agent only keeps its last call time and two price sums: Σ hits (input − cached) and
 * Σ anthropic misses (write − input); the result is prefix × (hits − misses).
 */
export class PromptCacheEstimate {
  private readonly agents = new Map<string, { last: number; hit: number; miss: number }>();
  add(row: UsageRow) {
    if (!row.agentId || !row.model || row.kind !== 'resposta' || row.cacheHit) return;
    const at = row.createdAt.getTime();
    const p = prices(row.model);
    let state = this.agents.get(row.agentId);
    if (!state) { state = { last: at, hit: 0, miss: 0 }; this.agents.set(row.agentId, state); }
    else if (at - state.last < FIVE_MINUTES) { state.hit += p.input - p.cached; state.last = at; return; }
    if (row.model.slug.startsWith('anthropic/')) state.miss += p.write - p.input;
    state.last = at;
  }
  value(prefixTokensByAgent: Record<string, number>): number | null {
    let total = 0; let any = false;
    for (const [agentId, state] of this.agents) {
      const prefix = prefixTokensByAgent[agentId];
      if (!prefix || prefix < PREFIX_MIN_TOKENS) continue;
      any = true;
      total += prefix * (state.hit - state.miss);
    }
    return any ? round(total / 1_000_000) : null;
  }
}
export function promptCacheEstimate(rows: UsageRow[], prefixTokensByAgent: Record<string, number>): number | null {
  const acc = new PromptCacheEstimate(); byTime(rows).forEach(row => acc.add(row)); return acc.value(prefixTokensByAgent);
}

/** Exact cache, measured: what each hit (billed 0) would have cost at its model's prices. */
export class ExactCacheSavings {
  private total = 0;
  add(row: UsageRow) { if (row.cacheHit && row.model) this.total += costAt(row, row.model); }
  value() { return round(this.total); }
}
export function exactCacheSavings(rows: UsageRow[]): number {
  const acc = new ExactCacheSavings(); rows.forEach(row => acc.add(row)); return acc.value();
}

/**
 * Exact cache, estimated: cost of the misses whose request hash repeats an earlier request of the same prefeitura
 * within the TTL. The TTL is anchored on the miss that would have written the entry (a read never extends it), so
 * a repeat after expiry becomes the new anchor. State: one anchor per (prefeitura, hash); expired anchors are
 * pruned as the stream moves on, so memory follows the hashes alive within one TTL.
 */
export class ExactCacheEstimate {
  private readonly anchors = new Map<string, number>();
  private total = 0;
  private pruneAt = 50_000;
  constructor(private readonly ttlSeconds: number) {}
  add(row: UsageRow) {
    if (!row.requestHash || row.cacheHit) return;
    const key = row.tenantId + ':' + row.requestHash;
    const at = row.createdAt.getTime();
    const ttl = this.ttlSeconds * 1000;
    const anchor = this.anchors.get(key);
    if (anchor !== undefined && at - anchor <= ttl) { this.total += price(row.cost); return; }
    // Re-inserted so the map stays in anchor order (oldest first).
    this.anchors.delete(key); this.anchors.set(key, at);
    if (this.anchors.size > this.pruneAt) {
      for (const [k, t] of this.anchors) { if (at - t <= ttl) break; this.anchors.delete(k); }
      this.pruneAt = Math.max(50_000, this.anchors.size * 2);
    }
  }
  value() { return round(this.total); }
}
export function exactCacheEstimate(rows: UsageRow[], ttlSeconds: number): number {
  const acc = new ExactCacheEstimate(ttlSeconds); byTime(rows).forEach(row => acc.add(row)); return acc.value();
}

/**
 * History summary, measured: saved history tokens of the answers at their input price, minus what the summaries
 * cost. Note for the label: the saved tokens are priced at the full input price, so the figure overstates the
 * savings when the prompt cache is also on (part of that history would have been read at the cached price).
 */
export class SummarySavings {
  private total = 0;
  add(row: UsageRow) {
    if (row.kind === 'resumo') this.total -= price(row.cost);
    else if (row.historySavedTokens > 0 && row.model) this.total += row.historySavedTokens * prices(row.model).input / 1_000_000;
  }
  value() { return round(this.total); }
}
export function summarySavings(rows: UsageRow[]): number {
  const acc = new SummarySavings(); rows.forEach(row => acc.add(row)); return acc.value();
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
export class ImageSavings {
  private real = 0; private estimate = 0;
  add(row: UsageRow) {
    if (!row.model?.slug.startsWith('openai/')) return;
    const input = prices(row.model).input;
    this.real += row.lowDetailImages * IMAGE_TOKENS_SAVED * input;
    this.estimate += row.highDetailImages * IMAGE_TOKENS_SAVED * input;
  }
  value() { return { real: round(this.real / 1_000_000), estimate: round(this.estimate / 1_000_000) }; }
}
export function imageSavings(rows: UsageRow[]): { real: number; estimate: number } {
  const acc = new ImageSavings(); rows.forEach(row => acc.add(row)); return acc.value();
}

/**
 * Model swaps made from the Central: each agent row after a TROCA_MODELO (and before that agent's next swap) that
 * used the new model, priced at the old model minus the new one; input, cache and output count, never below 0 per
 * row. A row belongs to the window of its agent's latest swap strictly before it (a row at the very instant of a
 * swap belongs to none). State: the events only.
 */
export class ModelSwapSavings {
  private readonly byAgent = new Map<string, ModelSwapEvent[]>();
  private total = 0;
  constructor(events: ModelSwapEvent[]) {
    for (const event of events) {
      if (event.kind !== 'TROCA_MODELO' || !event.agentId) continue;
      const list = this.byAgent.get(event.agentId);
      if (list) list.push(event); else this.byAgent.set(event.agentId, [event]);
    }
    for (const list of this.byAgent.values()) list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  add(row: UsageRow) {
    const list = row.agentId ? this.byAgent.get(row.agentId) : undefined;
    if (!list || !row.model) return;
    const at = row.createdAt.getTime();
    // Latest event at or before the row (binary search).
    let lo = 0; let hi = list.length - 1; let found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].createdAt.getTime() <= at) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    if (found < 0) return;
    const event = list[found];
    if (event.createdAt.getTime() === at || !event.toModelId || !event.from || row.modelId !== event.toModelId) return;
    this.total += Math.max(0, costAt(row, event.from) - costAt(row, row.model));
  }
  value() { return round(this.total); }
}
export function modelSwapSavings(rows: UsageRow[], events: ModelSwapEvent[]): number {
  const acc = new ModelSwapSavings(events); rows.forEach(row => acc.add(row)); return acc.value();
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
