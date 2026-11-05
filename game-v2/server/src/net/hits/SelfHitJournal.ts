/**
 * Client-detected hits, one client's journal on the server (docs/design/confirmed-hits.md part D). The client finds
 * its shells' hits itself and reports the low byte of its hit chain (common network/hits.ts hitHash, chainAdd) on its
 * inputs, only when the chain changes. Here is the server's chain for the same client, window by window (a window is
 * a snapshot: the hits it would have told as records), and the judging:
 *
 *   close   a window's hits go in (both those it was sent as records and those it should have found itself)
 *   report  the client's report: if it agrees with the chain as of its tick, everything up to there is settled
 *   judge   once a client must have heard a window and answered (`wait` ticks: its round trip and the report's wait),
 *           its chain as of then is its last report (silence: no change); agree, settled; disagree twice running
 *           (once is a hit seen a tick on the other side of a snapshot), a correction: every unsettled hit up to then
 *
 * After a correction the client's reports count one more (`epoch`, mod 4) and nothing is judged until its first such
 * report (it always sends one, with its new chain).
 */
import { hitHash, chainAdd, type ShellHitRecord } from '@space-game/common';

/** One hit as the client should have it, with its tick and damage (a correction always carries the number) */
export interface JournalHit { rec: ShellHitRecord; tick: number; dealt: number }

/** A correction to send (hitFix): the hits after `s` up to `t`, the server's chain as of `t`, the new epoch */
export interface JournalFix { s: number; t: number; c: number; e: number; hits: JournalHit[] }

/** A disagreement must last this many ticks (a second judging) before it's corrected */
const GRACE = 3;
/** After a correction, judging waits at most this long for the client's first report in the new count */
const AWAIT_MAX = 300;

export class SelfHitJournal {
  /** Unsettled windows that had hits, oldest first, with the chain after each */
  private wins: { tick: number; sum: number; hits: JournalHit[] }[] = [];
  /** The chain as of the latest window */
  private sum = 0;
  /** Settled up to this tick, the chain there */
  private baseTick: number;
  private base = 0;
  /** The client's reports not yet judged, and its value as of the last one judged */
  private claims: { tick: number; hash: number }[] = [];
  private claimed: { tick: number; hash: number };
  epoch = 0;
  private awaitingSince = -1;
  private badSince = -1;
  readonly stats = { hits: 0, reports: 0, stale: 0, agreed: 0, disagreed: 0, fixes: 0, fixHits: 0 };

  constructor(startTick: number) {
    this.baseTick = startTick;
    this.claimed = { tick: startTick, hash: 0 };
  }

  /** A window closes at `tick` with these hits (in the order the client will have them) */
  close(tick: number, hits: JournalHit[]): void {
    if (!hits.length) return;
    for (const h of hits) this.sum = chainAdd(this.sum, hitHash(h.rec.shell, h.rec.target, h.rec.part));
    this.wins.push({ tick, sum: this.sum, hits });
    this.stats.hits += hits.length;
  }

  /** The client's report: its chain's low byte as of `tick` (unwrapped), in its correction count `epoch` */
  report(tick: number, hash: number, epoch: number): void {
    if (epoch !== this.epoch) { this.stats.stale++; return; }
    this.stats.reports++;
    this.awaitingSince = -1;
    if (tick < this.claimed.tick) return;
    this.claims.push({ tick, hash });
    // (Agreeing now: no need to wait)
    const s = this.sumAt(tick);
    if ((s & 0xff) === hash) { this.stats.agreed++; this.settle(tick, s); }
  }

  /** Judge what the client must have answered for by now (`now - wait`): null, or a correction to send */
  judge(now: number, wait: number): JournalFix | null {
    if (this.awaitingSince >= 0) {
      if (now - this.awaitingSince < AWAIT_MAX) return null;
      this.awaitingSince = -1;
    }
    let j = now - wait;
    if (!this.wins.length || this.wins[0].tick > j) { this.badSince = -1; return null; }
    // Its value as of j: its last report at or before (none since: nothing changed)
    while (this.claims.length && this.claims[0].tick <= j) this.claimed = this.claims.shift()!;
    // (A report judged at its own tick, below, stays the one judged until j passes it)
    const ahead = this.claimed.tick > j;
    j = Math.max(j, this.claimed.tick);
    let s = this.sumAt(j);
    if ((s & 0xff) === this.claimed.hash) { this.stats.agreed++; this.settle(j, s); return null; }
    // A later report is already here (past j): the client's reports are rate-limited and fold the changes between into
    // the next, so its value at j is not known but at that report's own tick it is. Judge there: a client that was only
    // late to report agrees, and one that is wrong is corrected once, not once for the windows before its bad report
    if (this.claims.length && !ahead) {
      this.claimed = this.claims.shift()!;
      j = this.claimed.tick;
      s = this.sumAt(j);
      if ((s & 0xff) === this.claimed.hash) { this.stats.agreed++; this.settle(j, s); return null; }
    }
    this.stats.disagreed++;
    if (this.badSince < 0) { this.badSince = now; return null; }
    if (now - this.badSince < GRACE) return null;
    const hits: JournalHit[] = [];
    for (const w of this.wins) { if (w.tick > j) break; hits.push(...w.hits); }
    const from = this.baseTick;
    this.settle(j, s);
    this.epoch = (this.epoch + 1) & 3;
    this.claims = [];
    this.awaitingSince = now;
    this.stats.fixes++;
    this.stats.fixHits += hits.length;
    return { s: from, t: j, c: s, e: this.epoch, hits };
  }

  /** Unsettled hits (tests) */
  get unsettled(): number {
    return this.wins.reduce((n, w) => n + w.hits.length, 0);
  }

  /** The chain as of a tick: after the last window at or before it */
  private sumAt(tick: number): number {
    let s = this.base;
    for (const w of this.wins) { if (w.tick > tick) break; s = w.sum; }
    return s;
  }

  /** Everything up to `tick` agreed (or put right): dropped, the chain there the base */
  private settle(tick: number, sum: number): void {
    while (this.wins.length && this.wins[0].tick <= tick) this.wins.shift();
    this.base = sum;
    this.baseTick = Math.max(this.baseTick, tick);
    while (this.claims.length && this.claims[0].tick <= tick) this.claims.shift();
    this.claimed = { tick, hash: sum & 0xff };
    this.badSince = -1;
  }
}
