/**
 * Sliding-window attempt limits by key (an address, a username). Bounded: keys whose window has passed are
 * dropped, and past `maxKeys` the oldest go first, so a flood of new keys can't grow it or wipe everyone
 * else's count.
 */

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private limit: number, private windowMs: number, private maxKeys = 10_000, private clock: () => number = Date.now) {}

  /** Record an attempt; false (and not recorded) when the key is already at its limit */
  hit(key: string): boolean {
    if (this.blocked(key)) return false;
    this.record(key);
    return true;
  }

  /** At its limit? (records nothing) */
  blocked(key: string): boolean {
    return this.recent(key).length >= this.limit;
  }

  /** Count one (a failed attempt, say) */
  record(key: string): void {
    const list = this.recent(key);
    list.push(this.clock());
    this.hits.delete(key); // (re-added last: the Map's order is oldest-touched first)
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.prune();
  }

  /** Forget a key (a successful sign-in) */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Seconds until the key may try again (0: now) */
  retryAfter(key: string): number {
    const list = this.recent(key);
    if (list.length < this.limit) return 0;
    return Math.max(1, Math.ceil((list[list.length - this.limit] + this.windowMs - this.clock()) / 1000));
  }

  get size(): number {
    return this.hits.size;
  }

  private recent(key: string): number[] {
    const now = this.clock();
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }

  private prune(): void {
    const now = this.clock();
    for (const [k, list] of this.hits) if (!list.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    // Still full of live keys: drop the oldest tenth (not just one, so a flood doesn't prune on every hit)
    for (const k of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys * 0.9) break;
      this.hits.delete(k);
    }
  }
}
