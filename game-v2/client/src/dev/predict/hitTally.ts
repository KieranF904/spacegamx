/**
 * Hit agreement for the dev prediction modes: your own shells drawn striking a ship (WeaponFx `tally` 'struck', where the
 * drawn world had it) against the hits told for them (the tick layer's hits, which the server's hash confirms: 'confirmed'
 * on a shell drawn striking, 'landed' on one nothing drawn stopped). Pure (fed by WeaponFx.tally), so it tests alone.
 *
 *   agreed       drawn striking and told
 *   drawn only   drawn striking, nothing told within `waitMs` (you saw a hit that wasn't one)
 *   told only    told, never drawn striking (a hit you didn't see land: its shell flew through where the ship was drawn)
 *   agreement    agreed / (agreed + drawn only + told only), over the window
 * A strike drawn on a raised shield's bubble is counted apart (`shield`) and left out: what the server tells for a
 * shell its shield takes isn't a hull hit, so it would read as a miss in every mode alike.
 */
import { RateCounter, ValueWindow } from '../simOverlay/counters';

/**
 * Where your shells were drawn striking a ship against where that ship really was then: at each drawn strike, the
 * target's drawn place and the tick your shells were drawn at (k); once k is confirmed, the target's ST there (its
 * state in the collision step that met the shell: k for a pilot, k - 1 for anyone else). The gap, and the share of
 * strikes whose gap is under half the target's radius (`onTarget`: the shell would have met the ship there too). Unlike
 * the told-hit tally below, nothing else (shields, part deaths, how hits are told) moves it: only where ships are drawn.
 */
export class StrikeOffsets {
  private pending: { target: number; t: number; x: number; y: number; r: number }[] = [];
  private readonly gaps = new ValueWindow(6000);
  private readonly hits = new RateCounter(6000);
  private readonly misses = new RateCounter(6000);
  readonly totals = { strikes: 0, onTarget: 0, gapSum: 0 };

  constructor(
    /** The confirmed state of ship `id` at tick t (null: not known), and the newest confirmed tick */
    private readonly st: (id: number, t: number) => { x: number; y: number } | null,
    private readonly confirmed: () => number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** A strike drawn on `target` (drawn at x, y, radius r) by a shell drawn at tick k; `pilot`: hit-tested at k, else k - 1 */
  strike(target: number, k: number, pilot: boolean, x: number, y: number, r: number): void {
    this.pending.push({ target, t: pilot ? k : k - 1, x, y, r });
    if (this.pending.length > 2000) this.pending.splice(0, this.pending.length - 2000);
  }

  /** Strikes whose tick is confirmed now */
  update(): void {
    const c = this.confirmed(), now = this.now();
    let n = 0;
    for (const p of this.pending) {
      if (p.t > c) { this.pending[n++] = p; continue; }
      const s = this.st(p.target, p.t);
      if (!s) continue;
      const gap = Math.hypot(s.x - p.x, s.y - p.y);
      this.gaps.push(now, gap);
      this.totals.strikes++;
      this.totals.gapSum += gap;
      if (gap < p.r / 2) { this.hits.add(now); this.totals.onTarget++; } else this.misses.add(now);
    }
    this.pending.length = n;
  }

  read(): { gapMean: number; gapMax: number; onTargetPct: number } {
    this.update();
    const now = this.now(), h = this.hits.perSec(now), m = this.misses.perSec(now);
    return { gapMean: this.gaps.mean(now), gapMax: this.gaps.max(now), onTargetPct: h + m > 0 ? (100 * h) / (h + m) : NaN };
  }

  reset(): void {
    this.pending = [];
    this.totals.strikes = this.totals.onTarget = this.totals.gapSum = 0;
    const far = this.now() + 1e9;
    this.gaps.mean(far); this.hits.perSec(far); this.misses.perSec(far);
  }
}

/** How near a told hit with no shell must be to a drawn strike to be its (world units) */
const ORPHAN_REACH = 60;

export class HitTally {
  /** Own shells drawn striking a ship, waiting for their told hit: id -> when and where */
  private waiting = new Map<number, { at: number; x: number; y: number }>();
  private readonly agreed = new RateCounter(6000);
  private readonly drawnOnly = new RateCounter(6000);
  private readonly toldOnly = new RateCounter(6000);
  readonly totals = { agreed: 0, drawnOnly: 0, toldOnly: 0, shield: 0 };

  constructor(
    /** Is this shell's owner you (owner -1: no longer held, look it up by id) */
    private readonly own: (owner: number) => boolean,
    /** Is this target a ship (not a rock) */
    private readonly ship: (target: number) => boolean,
    private readonly now: () => number = () => performance.now(),
    /** How long a drawn strike waits for its told hit (a round trip and a snapshot window) */
    public waitMs = 1500,
    /** Has this target a shield up (drawn as a bubble) */
    private readonly shielded: (target: number) => boolean = () => false,
  ) {}

  /** WeaponFx.tally */
  readonly tally = (what: 'struck' | 'confirmed' | 'landed' | 'renamed' | 'orphan', shot: number, owner: number, target: number, x = NaN, y = NaN): void => {
    const now = this.now();
    if (what === 'renamed') {
      // (A shell fired here (a local id) taking the server's id: its hit is told under that one)
      const w = this.waiting.get(target);
      if (w !== undefined) { this.waiting.delete(target); this.waiting.set(shot, w); }
      return;
    }
    if (what === 'struck') {
      if (!this.own(owner) || !this.ship(target)) return;
      if (this.shielded(target)) this.totals.shield++;
      else this.waiting.set(shot, { at: now, x, y });
      return;
    }
    if (what === 'orphan') {
      // (A told hit whose shell isn't held under that id (fired here under another, or let go): the drawn strike
      // nearest its point, if one is close enough, is the one it tells)
      let best = -Infinity, bd = ORPHAN_REACH;
      for (const [id, w] of this.waiting) { const d = Math.hypot(w.x - x, w.y - y); if (d < bd) { bd = d; best = id; } }
      if (best !== -Infinity) { this.waiting.delete(best); this.agreed.add(now); this.totals.agreed++; }
      return;
    }
    if (this.waiting.delete(shot)) { this.agreed.add(now); this.totals.agreed++; return; }
    // (A told hit on a shell drawn striking a rock, or someone else's: not counted)
    if (what === 'landed' && this.own(owner)) { this.toldOnly.add(now); this.totals.toldOnly++; }
  };

  /** Drawn strikes that waited too long: drawn only */
  private expire(now: number): void {
    for (const [id, w] of this.waiting) {
      if (now - w.at < this.waitMs) continue;
      this.waiting.delete(id);
      this.drawnOnly.add(now);
      this.totals.drawnOnly++;
    }
  }

  /** Rates a second over the window, and the agreement (NaN: no hits in the window) */
  read(): { agreed: number; drawnOnly: number; toldOnly: number; agreement: number } {
    const now = this.now();
    this.expire(now);
    const a = this.agreed.perSec(now), d = this.drawnOnly.perSec(now), t = this.toldOnly.perSec(now);
    return { agreed: a, drawnOnly: d, toldOnly: t, agreement: a + d + t > 0 ? a / (a + d + t) : NaN };
  }

  reset(): void {
    this.waiting.clear();
    this.totals.agreed = this.totals.drawnOnly = this.totals.toldOnly = this.totals.shield = 0;
    const now = this.now();
    for (const c of [this.agreed, this.drawnOnly, this.toldOnly]) c.perSec(now + 1e9);
  }
}
