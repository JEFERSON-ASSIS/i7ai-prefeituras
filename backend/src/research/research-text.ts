export type Fonte = { titulo: string; link: string };

export const RESEARCH_TIMEOUT_MS = 10_000;
export const RESEARCH_MAX_BODY_BYTES = 1024 * 1024;

export type FetchLike = (url: string, init?: any) => Promise<Response>;

export function clip(value: unknown, maxChars = 12000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const marker = '…(cortado)';
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

export function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function searchWords(term: string): string[] {
  const words = stripAccents(term)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);
  return [...new Set(words)];
}

function requestSignal(caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(RESEARCH_TIMEOUT_MS);
  return caller ? AbortSignal.any([timeout, caller]) : timeout;
}

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, RESEARCH_MAX_BODY_BYTES);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < RESEARCH_MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, RESEARCH_MAX_BODY_BYTES).toString('utf8');
}

/** Faz a chamada com tempo limite de 10 s (somado ao sinal do chamador) e lê no máximo 1 MB. */
export const RETRY_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [250, 750, 1500];
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

/** A dropped or refused connection (not a timeout of the whole request, not a redirect or a caller abort). */
export function isTransientNetworkError(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  return error instanceof TypeError && !!cause?.code && TRANSIENT_CODES.has(cause.code);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

export async function requestJson(
  fetchFn: FetchLike,
  url: string,
  init: Record<string, unknown>,
  caller?: AbortSignal,
): Promise<{ status: number; ok: boolean; data: any }> {
  // Public sources (PNCP above all) drop connections often: retry dropped connections and 502/503/504.
  let response: Awaited<ReturnType<FetchLike>> | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await fetchFn(url, { ...init, redirect: 'error', signal: requestSignal(caller) });
      if (![502, 503, 504].includes(response.status) || attempt >= RETRY_ATTEMPTS) break;
    } catch (error) {
      if (caller?.aborted || attempt >= RETRY_ATTEMPTS || !isTransientNetworkError(error)) throw error;
    }
    await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 750, caller);
  }
  const text = await readLimited(response!);
  let data: any = null;
  let parsed = true;
  try { data = text ? JSON.parse(text) : null; } catch { parsed = false; }
  return { status: response!.status, ok: response!.ok && parsed, data };
}
