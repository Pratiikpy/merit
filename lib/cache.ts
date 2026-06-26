/**
 * Tiny LRU + TTL cache — pure and deterministic (pass `now` for tests).
 *
 * Bounds both memory (at most `max` entries, least-recently-used evicted first) and staleness (an entry
 * expires `ttlMs` after it was written). Merit uses it to cache Auditor verdicts so an identical
 * (claim, source) citation isn't re-judged by the LLM on every run or appeal — cutting provider load at the
 * exact moment concurrency, and the 429 risk, are highest. No dependencies; safe in any JS runtime.
 */
export class TTLCache<V> {
  private readonly map = new Map<string, { v: V; exp: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  /** Returns the cached value if present and unexpired (refreshing its recency), else undefined. */
  get(key: string, now: number = Date.now()): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (now >= e.exp) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency for the LRU order: delete + re-insert moves it to the newest position.
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  set(key: string, v: V, now: number = Date.now()): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { v, exp: now + this.ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value; // Map preserves insertion order → oldest first
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
