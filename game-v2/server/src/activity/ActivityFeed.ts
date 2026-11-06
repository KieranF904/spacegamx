/**
 * The activity feed's transport: events queued, rate limited, summed and sent to the lobby in batches.
 *
 * - emit(): one event. At most PER_KEY_PER_MIN a minute for one type and pilot, and GLOBAL_PER_MIN for the whole
 *   server; past those it's counted and the next batch says how many were dropped. A `quietMs` key keeps one kind of
 *   event to one per that long (docking at the same station, a repeated error).
 * - tally(): something that happens often (kills, ore mined, private messages): added up per pilot and type, and sent
 *   as one line every TALLY_MS, or when the pilot leaves (flushTallies).
 * - pump(): sends what's queued, up to MAX_BATCH a call, every FLUSH_MS (start() runs it; tests call it). If the lobby
 *   doesn't take it (down, refused), the queue waits and the next try backs off (up to a minute); past MAX_QUEUE the
 *   oldest go. Nothing here ever throws into the game.
 *
 * Pure: the clock and the send are given (index.ts gives a fetch to the lobby), so tests drive it by hand.
 */

export interface FeedEvent {
  at: number;
  type: string;
  player: string;
  other?: string;
  detail: string;
}

export interface FeedOptions {
  /** Hand a batch to the lobby: true when it was taken */
  send(events: FeedEvent[]): Promise<boolean>;
  now?: () => number;
  /** Which event types go out at all (index.ts: the ACTIVITY_TYPES registry); the rest are dropped silently. Default: all */
  enabled?: (type: string) => boolean;
  maxBatch?: number;
  maxQueue?: number;
  perKeyPerMin?: number;
  globalPerMin?: number;
  tallyMs?: number;
}

export const FLUSH_MS = 3000;
export const MAX_BATCH = 100;
export const MAX_QUEUE = 2000;
export const PER_KEY_PER_MIN = 20;
export const GLOBAL_PER_MIN = 600;
export const TALLY_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60_000;
/** Most rate-limit and quiet keys kept (a flood of new names can't grow them) */
const MAX_KEYS = 5000;

interface Tally { type: string; player: string; since: number; counts: Map<string, number>; format: (counts: Map<string, number>) => string }

export class ActivityFeed {
  private queue: FeedEvent[] = [];
  private windows = new Map<string, { start: number; n: number }>();
  private quiet = new Map<string, number>();
  private tallies = new Map<string, Tally>();
  private dropped = 0;
  private lost = 0;
  private failures = 0;
  private nextTry = 0;
  private sending = false;
  private now: () => number;
  private o: Required<Omit<FeedOptions, 'send' | 'now' | 'enabled'>>;

  constructor(private opts: FeedOptions) {
    this.now = opts.now ?? Date.now;
    this.o = {
      maxBatch: opts.maxBatch ?? MAX_BATCH, maxQueue: opts.maxQueue ?? MAX_QUEUE, perKeyPerMin: opts.perKeyPerMin ?? PER_KEY_PER_MIN,
      globalPerMin: opts.globalPerMin ?? GLOBAL_PER_MIN, tallyMs: opts.tallyMs ?? TALLY_MS,
    };
  }

  /** Events waiting to go (tests, the shutdown flush) */
  get pending(): number {
    return this.queue.length;
  }

  /** One event; `quiet`: none of the same key again within that many ms. False if it was held back */
  emit(type: string, player: string, detail: string, other = '', quiet?: { key: string; ms: number }): boolean {
    if (this.opts.enabled && !this.opts.enabled(type)) return false;
    const t = this.now();
    if (quiet) {
      const k = `${type}|${player}|${quiet.key}`;
      if (t - (this.quiet.get(k) ?? -Infinity) < quiet.ms) return false;
      if (this.quiet.size >= MAX_KEYS) this.quiet.clear();
      this.quiet.set(k, t);
    }
    if (!this.allow(`${type}|${player}`, this.o.perKeyPerMin, t) || !this.allow('*', this.o.globalPerMin, t)) { this.dropped++; return false; }
    this.push({ at: t, type, player, ...(other ? { other } : {}), detail });
    return true;
  }

  /** Add `n` of `what` to this pilot's running count for `type`, sent as one line (`format`) every TALLY_MS */
  tally(type: string, player: string, what: string, n: number, format: (counts: Map<string, number>) => string): void {
    if (!(n > 0) || (this.opts.enabled && !this.opts.enabled(type))) return;
    const key = `${type}|${player}`;
    let t = this.tallies.get(key);
    if (!t) {
      if (this.tallies.size >= MAX_KEYS) return;
      t = { type, player, since: this.now(), counts: new Map(), format };
      this.tallies.set(key, t);
    }
    t.counts.set(what, (t.counts.get(what) ?? 0) + n);
  }

  /** Send the running counts now: one pilot's (they left), or every one that's due (`all`: every one) */
  flushTallies(player?: string, all = false): void {
    const t = this.now();
    for (const [key, tally] of this.tallies) {
      if (player !== undefined ? tally.player !== player : !all && t - tally.since < this.o.tallyMs) continue;
      this.tallies.delete(key);
      if (tally.counts.size) this.push({ at: t, type: tally.type, player: tally.player, detail: tally.format(tally.counts) });
    }
  }

  /** Send a batch if one's due (never throws; one call at a time) */
  async pump(): Promise<void> {
    this.flushTallies();
    const t = this.now();
    if (this.sending || t < this.nextTry) return;
    // (What was dropped rides along at the front of the batch, never in the queue: it mustn't push real events out)
    const dropped = this.dropped, lost = this.lost;
    const note: FeedEvent[] = dropped || lost
      ? [{ at: t, type: 'dropped', player: '', detail: `Events not sent: ${[dropped ? `${dropped} over the rate limit` : '', lost ? `${lost} while the lobby was unreachable` : ''].filter(Boolean).join(', ')}` }]
      : [];
    if (!this.queue.length && !note.length) return;
    const taken = this.queue.slice(0, this.o.maxBatch - note.length);
    this.sending = true;
    let ok = false;
    try { ok = await this.opts.send([...note, ...taken]); } catch { ok = false; }
    this.sending = false;
    if (ok) {
      // (Events queued meanwhile stay; only the batch sent goes)
      this.queue.splice(0, taken.length);
      this.dropped -= dropped;
      this.lost -= lost;
      this.failures = 0;
      this.nextTry = 0;
    } else {
      this.failures++;
      this.nextTry = this.now() + Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (this.failures - 1));
    }
  }

  /** True while the lobby isn't taking batches */
  get failing(): boolean {
    return this.failures > 0;
  }

  private push(e: FeedEvent): void {
    this.queue.push(e);
    if (this.queue.length > this.o.maxQueue) this.lost += this.queue.splice(0, this.queue.length - this.o.maxQueue).length;
  }

  private allow(key: string, limit: number, t: number): boolean {
    let w = this.windows.get(key);
    if (!w || t - w.start >= 60_000) {
      if (!w && this.windows.size >= MAX_KEYS) this.windows.clear();
      w = { start: t, n: 0 };
      this.windows.set(key, w);
    }
    if (w.n >= limit) return false;
    w.n++;
    return true;
  }
}
