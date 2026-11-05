/**
 * Pulls as the step takes them (sim foundation, Stage 1C; the PullSource contract in env.ts, applied by pulls.ts
 * applyPulls inside the step, after the motion).
 *
 * Two kinds of source, worked out alike on every end that has what they read:
 *   PullLog     pulls a decision made on the tick before (a Scrap Mother's magnets, a Hookboat's reel, a custom
 *               enemy's pull: common bodies/moves pullOne / pullTowards): each a velocity for one ship, logged for the
 *               tick it acts on. The server's moves log them as they run; a client running the same body's moves
 *               (CAPS.MOVES) logs the same ones, so it needs no PULL cause for them
 *   PullFields  pulls from a place (a collapsing star's held orb): every ship within its reach is drawn in, by where
 *               the ship is as the pull acts (starPull, the server's Weapons.ts formula)
 * `pullSources` puts several together; each ship's pulls come by puller id, ascending (env.ts), a puller's own in the
 * order it made them.
 */

import { dhypot } from '../math/detTrig.js';
import type { PullSource } from './env.js';

export type Pull = readonly [from: number, ax: number, ay: number];

const NONE: readonly Pull[] = [];

/** Pulls by the tick they act on and the ship they act on */
export class PullLog implements PullSource {
  private readonly by = new Map<number, Map<number, Pull[]>>();
  private hi = -Infinity;

  constructor(
    /** Ticks kept behind the newest logged */
    private readonly keep = 600,
  ) {}

  /** A pull on ship `target` acting on tick t (velocity per tick, world units), made by `from` */
  add(t: number, target: number, from: number, ax: number, ay: number): void {
    let m = this.by.get(t);
    if (!m) this.by.set(t, (m = new Map()));
    const l = m.get(target);
    const p: Pull = [from, ax, ay];
    if (!l) { m.set(target, [p]); }
    else {
      // (By puller id; a puller's own in the order made)
      let i = l.length;
      while (i > 0 && l[i - 1][0] > from) i--;
      l.splice(i, 0, p);
    }
    if (t > this.hi) {
      this.hi = t;
      if (this.by.size > this.keep) for (const k of this.by.keys()) if (k <= t - this.keep) this.by.delete(k);
    }
  }

  on(id: number, t: number): readonly Pull[] {
    return this.by.get(t)?.get(id) ?? NONE;
  }

  /** Every ship pulled on tick t */
  targets(t: number): IterableIterator<number> {
    return (this.by.get(t) ?? new Map<number, Pull[]>()).keys();
  }

  /** Forget the pulls made by `from` acting from tick t on (its moves are run again from t - 1) */
  dropBy(from: number, t: number): void {
    for (const [k, m] of this.by) {
      if (k < t) continue;
      for (const [id, l] of m) {
        const kept = l.filter((p) => p[0] !== from);
        if (kept.length === l.length) continue;
        if (kept.length) m.set(id, kept); else m.delete(id);
      }
      if (!m.size) this.by.delete(k);
    }
  }

  dropFrom(t: number): void {
    for (const k of [...this.by.keys()]) if (k >= t) this.by.delete(k);
  }

  clear(): void {
    this.by.clear();
    this.hi = -Infinity;
  }
}

/** A pull from a place: `strength` at its centre falling off as (1 - d / radius)², nothing past `radius` (a collapsing star) */
export interface PullField {
  from: number;
  x: number;
  y: number;
  radius: number;
  strength: number;
  /** Ships it doesn't pull (its owner) */
  skip?: number;
}

/** A collapsing star's pull on a ship at (x, y): [ax, ay], or null out of reach (the server's Weapons.ts formula) */
export function starPull(f: Readonly<PullField>, x: number, y: number): [number, number] | null {
  const dx = f.x - x, dy = f.y - y, d = dhypot(dx, dy);
  if (d > f.radius || d < 1) return null;
  const u = 1 - d / f.radius;
  const k = f.strength * u * u * 2;
  return [(dx / d) * k, (dy / d) * k];
}

/** Fields by the tick they act on */
export class PullFields implements PullSource {
  private readonly by = new Map<number, PullField[]>();

  set(t: number, fields: PullField[]): void {
    this.by.set(t, [...fields].sort((a, b) => a.from - b.from));
    if (this.by.size > 600) for (const k of this.by.keys()) if (k < t - 600) this.by.delete(k);
  }

  on(id: number, t: number, at: { x: number; y: number }): readonly Pull[] {
    const fs = this.by.get(t);
    if (!fs) return NONE;
    let out: Pull[] | null = null;
    for (const f of fs) {
      if (f.from === id || f.skip === id) continue;
      const p = starPull(f, at.x, at.y);
      if (p) (out ??= []).push([f.from, p[0], p[1]]);
    }
    return out ?? NONE;
  }
}

/** Several sources as one: each ship's pulls merged by puller id */
export function pullSources(...srcs: PullSource[]): PullSource {
  return {
    on(id, t, at) {
      let out: Pull[] | null = null;
      for (const s of srcs) {
        const l = s.on(id, t, at);
        if (l.length) (out ??= []).push(...l);
      }
      if (!out) return NONE;
      // (Stable: a puller's own keep the order made)
      return out.map((p, i) => [p, i] as const).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]).map((x) => x[0]);
    },
  };
}
