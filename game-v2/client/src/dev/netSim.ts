/**
 * Network simulator (dev only): ping, jitter and loss on top of the real connection, both ways. NetworkManager holds one in
 * its `netSim` slot (null unless a dev build installs it: app/devTools.ts, the Sim tools panel); every send and every received
 * frame goes through route(). Off by default: `enabled` false passes everything straight through, unchanged.
 *
 *   ping    the round trip added (ms): half each way
 *   jitter  +/- ms of random wobble on each trip. It never reorders (a WebSocket is TCP): a late one holds up the ones behind it
 *   loss    percent of "droppable" things dropped. Only what a game can survive losing: inputs going out (dropped before they
 *           are encoded, so the compact-input stream stays consistent) and snapshots coming in. Everything else is delayed, never lost.
 *
 * Deterministic: delay and loss come from a seeded generator and an injectable clock/timer, so the tests replay exactly.
 */

export interface NetSimConfig {
  enabled: boolean;
  /** Round trip added, ms */
  ping: number;
  /** +/- ms on each trip */
  jitter: number;
  /** Percent (0-100) of droppable messages lost, each way */
  loss: number;
}

export type Dir = 'up' | 'down';

export interface NetSimDeps {
  now: () => number;
  /** Run fn after ms (setTimeout) */
  later: (fn: () => void, ms: number) => void;
  /** A seeded 0..1 generator */
  rand: () => number;
}

/** mulberry32 */
export function seeded(seed: number): () => number {
  let a = (seed | 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class NetSim {
  readonly config: NetSimConfig = { enabled: false, ping: 0, jitter: 0, loss: 0 };
  /** What it has done since the counters were reset: passed through, dropped, and the delay it added last */
  readonly stats = { passed: 0, dropped: 0, lastDelay: 0 };
  private readonly last: Record<Dir, number> = { up: 0, down: 0 };
  private readonly deps: NetSimDeps;

  constructor(deps?: Partial<NetSimDeps>, seed = 1) {
    this.deps = {
      now: deps?.now ?? (() => performance.now()),
      later: deps?.later ?? ((fn, ms) => { setTimeout(fn, ms); }),
      rand: deps?.rand ?? seeded(seed),
    };
  }

  /** On the wire only when enabled and something is set */
  get active(): boolean { const c = this.config; return c.enabled && (c.ping > 0 || c.jitter > 0 || c.loss > 0); }

  /**
   * Hand a delivery to the simulator. `droppable` ones may be lost. Returns false if dropped. With nothing set, `deliver` runs at once.
   * Order is kept: a delivery never lands before an earlier one in the same direction.
   */
  route(dir: Dir, droppable: boolean, deliver: () => void): boolean {
    const c = this.config;
    const now = this.deps.now();
    if (!this.active) {
      // (A delivery already waiting goes first: switching off mid-flight must not reorder)
      const wait = this.last[dir] - now;
      this.stats.passed++;
      if (wait > 0) this.deps.later(deliver, wait);
      else deliver();
      return true;
    }
    if (droppable && c.loss > 0 && this.deps.rand() * 100 < c.loss) { this.stats.dropped++; return false; }
    const wobble = c.jitter > 0 ? (this.deps.rand() * 2 - 1) * c.jitter : 0;
    const at = Math.max(now + Math.max(0, c.ping / 2 + wobble), this.last[dir]);
    this.last[dir] = at;
    this.stats.lastDelay = at - now;
    this.stats.passed++;
    if (at - now <= 0) deliver();
    else this.deps.later(deliver, at - now);
    return true;
  }

  /** Roll for a loss now (counts a drop when it hits): for callers that decide what to drop themselves */
  rollLoss(): boolean {
    if (!this.active || this.config.loss <= 0) return false;
    if (this.deps.rand() * 100 < this.config.loss) { this.stats.dropped++; return true; }
    return false;
  }

  resetStats(): void { this.stats.passed = 0; this.stats.dropped = 0; this.stats.lastDelay = 0; }
}
