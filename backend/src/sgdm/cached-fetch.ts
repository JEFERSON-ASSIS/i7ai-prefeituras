type Entry<V> = { expires: number; staleUntil: number; value?: V; error?: unknown };

/** Reads a non-negative number of seconds from an env var; empty, invalid or negative values fall back. */
export function envSeconds(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** SGDM_FAILURE_CACHE_SECONDS: how long a failed SGDM read is remembered before SGDM is retried (default 15). */
export const sgdmFailureSeconds = () => envSeconds('SGDM_FAILURE_CACHE_SECONDS', 15);

export type CachedFetchOptions = {
  /** Success TTL in seconds (read on every call so env changes apply). */
  ttlSeconds: () => number;
  /** Seconds past the TTL during which the last value may be served when SGDM fails. Infinity = no limit. */
  staleSeconds: number;
  /** Seconds a failure is remembered before the next real attempt. */
  failureSeconds: () => number;
  maxEntries?: number;
};

type FailureHook = (error: unknown, servedStale: boolean) => void;

/**
 * Per-key cache for SGDM reads: a success TTL, a stale window, single-flight (concurrent callers share one load)
 * and a failure window. When `load` throws: a still-usable stale value is served and not retried until the failure
 * window ends (never past the stale limit); otherwise the error is remembered and re-thrown to every caller in the
 * window without calling `load` again. `onFailure` runs once per real failed attempt (log-once), never for replays.
 * Definitive answers (e.g. 404) must be handled inside `load` and returned as a value so they are cached normally.
 */
export class CachedFetch<V> {
  private readonly cache = new Map<string, Entry<V>>();
  private readonly inFlight = new Map<string, Promise<V>>();
  private readonly max: number;

  constructor(private readonly options: CachedFetchOptions) { this.max = options.maxEntries ?? 5000; }

  get(key: string, load: () => Promise<V>, onFailure?: FailureHook): Promise<V> {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.error !== undefined ? Promise.reject(hit.error) : Promise.resolve(hit.value as V);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const request = this.run(key, hit, load, onFailure).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private async run(key: string, hit: Entry<V> | undefined, load: () => Promise<V>, onFailure?: FailureHook): Promise<V> {
    try {
      const value = await load();
      const now = Date.now(); const ttl = this.options.ttlSeconds() * 1000;
      this.store(key, { expires: now + ttl, staleUntil: now + ttl + this.options.staleSeconds * 1000, value });
      return value;
    } catch (error) {
      const failedAt = Date.now(); const retryAt = failedAt + this.options.failureSeconds() * 1000;
      if (hit && hit.error === undefined && hit.staleUntil > failedAt) {
        onFailure?.(error, true);
        // Serve the stale value without retrying until the failure window ends (never past staleUntil).
        hit.expires = Math.min(retryAt, hit.staleUntil);
        return hit.value as V;
      }
      onFailure?.(error, false);
      this.store(key, { expires: retryAt, staleUntil: retryAt, error });
      throw error;
    }
  }

  private store(key: string, entry: Entry<V>) {
    this.cache.delete(key);
    if (this.cache.size >= this.max) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, entry);
  }
}
