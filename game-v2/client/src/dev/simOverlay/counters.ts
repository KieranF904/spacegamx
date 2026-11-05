/** Rolling counters for the overlay: pure, so they test without a browser */

/** Events in the last `windowMs`, as a rate a second */
export class RateCounter {
  private at: number[] = [];
  constructor(private readonly windowMs = 2000) {}
  add(now: number, n = 1): void { for (let i = 0; i < n; i++) this.at.push(now); }
  perSec(now: number): number {
    const from = now - this.windowMs;
    while (this.at.length && this.at[0] < from) this.at.shift();
    return (this.at.length * 1000) / this.windowMs;
  }
}

/** Samples in the last `windowMs`: mean and max */
export class ValueWindow {
  private s: { t: number; v: number }[] = [];
  constructor(private readonly windowMs = 4000) {}
  push(now: number, v: number): void { this.s.push({ t: now, v }); }
  private trim(now: number): void { const from = now - this.windowMs; while (this.s.length && this.s[0].t < from) this.s.shift(); }
  mean(now: number): number { this.trim(now); return this.s.length ? this.s.reduce((a, x) => a + x.v, 0) / this.s.length : 0; }
  max(now: number): number { this.trim(now); return this.s.reduce((a, x) => Math.max(a, x.v), 0); }
  count(now: number): number { this.trim(now); return this.s.length; }
}

/**
 * Reads GameState's reconcile statistics once a frame and turns changes into events. GameState keeps only running values
 * (predErrorPre of the last reconcile, its average, predPendingCount); a reconcile is noticed when either changes.
 * (Approximate: two reconciles in one frame count as one. Stage 3 replaces this with a real counter.)
 */
export class ReconcileWatcher {
  private lastPre = NaN;
  private lastAvg = NaN;
  private lastSnaps = 0;
  readonly corrections = new RateCounter();
  readonly resteps = new RateCounter();
  readonly sizes = new ValueWindow();

  observe(now: number, s: { predErrorPre: number; predErrorPreAvg: number; predPendingCount: number; predSnapCount: number }): { size: number; ticks: number; snapped: boolean } | null {
    const changed = s.predErrorPre !== this.lastPre || s.predErrorPreAvg !== this.lastAvg;
    const snapped = s.predSnapCount !== this.lastSnaps;
    const first = Number.isNaN(this.lastPre);
    this.lastPre = s.predErrorPre; this.lastAvg = s.predErrorPreAvg; this.lastSnaps = s.predSnapCount;
    if (!changed || first) return null;
    this.corrections.add(now);
    this.resteps.add(now, s.predPendingCount);
    this.sizes.push(now, s.predErrorPre);
    return { size: s.predErrorPre, ticks: s.predPendingCount, snapped };
  }
}
