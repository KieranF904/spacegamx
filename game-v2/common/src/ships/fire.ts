/**
 * @contract common.ships.fire
 * owns:       how a spreading fire (a Burn modifier's: tuning.ts ignite.fire) moves over a ship's parts: the chance a
 *             burning part lights a joined neighbour, the chance a fire that has burned out keeps going, and the step
 *             that runs both on a ship's fires (stepFires); the parts a shot's line meets behind the one it struck
 *             (partsBehind: the layers a piercing shot lights)
 * needs:      math/rng (hashUnit), design.ts (a design's joins), hitRules.ts castShipAt; no state of its own
 * invariants: fire feeds fire: a part's chance to light a neighbour, and to keep burning past its time, never falls
 *             as more of the parts joined to it burn; a part with none burning never outlasts its time —
 *             common/src/ships/fire.test.ts
 *             it always falls off: each spread or renewal is a generation on (cooler, shorter), no fire passes
 *             `gens`, none burns past `total` ticks from the shot that started it, and one shot lights at most
 *             `parts` parts — common/src/ships/fire.test.ts
 *             every roll is hashUnit of (ship, part, part, tick): the same fires on the same ship at the same tick
 *             step the same way anywhere — common/src/ships/fire.test.ts
 *             a fire without `fire` (any gun's own: magma, the Cinder Bloom, a vent) is never stepped here, and
 *             counts only as a neighbour that burns — common/src/ships/fire.test.ts
 * extend:     a new rule of the fire's is a field of FireSpread (tuning.json modifiers.burn.fire) read here
 */

import { hashUnit } from '../math/rng.js';
import type { Vec2, Blueprint } from './types.js';
import type { Catalog } from './catalog.js';
import { designOf } from './design.js';
import type { PlacedGeom } from './grid.js';
import { castShipAt } from './hitRules.js';

/** Ticks between a ship's fire steps (the server's burn step: bridge/damage.ts stepBurns); a fire's `beat` is a multiple */
export const FIRE_STEP = 10;

/** How a spreading fire behaves (tuning.json modifiers.burn.fire, carried on the def: tuning.ts ignite.fire) */
export interface FireSpread {
  /** Ticks between a burning part's tries at its neighbours */
  beat: number;
  /** A try's chance with no other part burning beside the one that tries, and what each burning neighbour adds, up to `cap` */
  base: number; per: number; cap: number;
  /** The chance a fire at the end of its time burns on, for each neighbour burning, up to `surviveCap` (none burning: none) */
  survive: number; surviveCap: number;
  /** Each generation on: its heat × `keep`, its time × `time`, its chances × `fade` */
  keep: number; time: number; fade: number;
  /** The last generation (the shot's own fire is 0) */
  gens: number;
  /** No fire of one shot's burns past this many ticks from the shot */
  total: number;
  /** The most parts one shot's fire is ever on (the first counted) */
  parts: number;
}

/** One shot's fire, shared by every part it spread to */
export interface FireShot { born: number; lit: number }

/** A part on fire. Without `fire` it is another kind's (it burns, and neither spreads nor is stepped here) */
export interface PartFire {
  part: number;
  /** The tick it burns out, its damage a second, and the time its spell was lit for */
  until: number; dps: number; ticks?: number;
  fire?: FireSpread;
  gen?: number;
  ev?: FireShot;
}

const ADJ = new WeakMap<readonly (readonly [number, number])[], number[][]>();

/** The parts joined to each part (design.ts joins), lowest first; kept for the joins list it was made from */
export function fireNeighbours(joins: readonly (readonly [number, number])[], parts: number): number[][] {
  let adj = ADJ.get(joins);
  if (adj && adj.length === parts) return adj;
  adj = Array.from({ length: parts }, () => [] as number[]);
  for (const [a, b] of joins) { if (a < parts && b < parts && a !== b) { adj[a].push(b); adj[b].push(a); } }
  for (const l of adj) l.sort((p, q) => p - q);
  ADJ.set(joins, adj);
  return adj;
}

/** A generation's share of a chance (`fade` each generation on) */
function faded(s: FireSpread, gen: number): number {
  let k = 1;
  for (let i = 0; i < gen; i++) k *= s.fade;
  return k;
}

/** The chance a burning part of generation `gen` lights one joined neighbour on a beat, `burning` of its neighbours alight */
export function spreadChance(s: FireSpread, burning: number, gen: number): number {
  if (gen >= s.gens) return 0;
  return Math.min(s.cap, s.base + s.per * Math.max(0, burning)) * faded(s, gen);
}

/** The chance a fire of generation `gen` at the end of its time burns on, `burning` of its neighbours alight */
export function surviveChance(s: FireSpread, burning: number, gen: number): number {
  if (gen >= s.gens || burning <= 0) return 0;
  return Math.min(s.surviveCap, s.survive * burning) * faded(s, gen);
}

/** What a fire a generation on from `f` burns with: its heat and its time (at least a step) */
export function nextGen(s: FireSpread, f: PartFire): { dps: number; ticks: number } {
  return { dps: f.dps * s.keep, ticks: Math.max(FIRE_STEP, Math.round(((f.ticks ?? 0) * s.time) / FIRE_STEP) * FIRE_STEP) };
}

/**
 * One step of a ship's fires at `tick` (every FIRE_STEP ticks). `fires`: every fire on the ship, changed in place.
 *   - a spreading fire on a part that is gone goes out (`alive`);
 *   - one at the end of its time rolls to burn on, a generation on (surviveChance), else it is dropped;
 *   - on its beat, each spreading fire rolls for each joined neighbour that stands and is not alight (spreadChance):
 *     `make` gives the new fire's record (from the one that lit it), and it joins the list.
 * `told(f, from)`: a fire was lit (from: the fire that lit it) or burned on (from: null). `key`: the ship (its entity).
 */
export function stepFires<T extends PartFire>(
  key: number, fires: T[], adj: readonly (readonly number[])[], alive: (part: number) => boolean, tick: number,
  make: (from: T, part: number) => T, told?: (f: T, from: T | null) => void,
): void {
  const lit = (part: number): boolean => { for (const f of fires) if (f.part === part && f.until > tick) return true; return false; };
  const around = (part: number): number => { let n = 0; for (const o of adj[part] ?? []) if (alive(o) && lit(o)) n++; return n; };
  // What burns beside each fire as the step starts: every roll of the step reads the same picture
  const beside = fires.map((f) => (f.fire ? around(f.part) : 0));
  const n0 = fires.length;
  for (let i = 0; i < n0; i++) {
    const f = fires[i], s = f.fire;
    if (!s || !f.ev) continue;
    if (!alive(f.part)) { f.until = -1; continue; }
    if (tick < f.until) continue;
    // Its time is up: does it burn on?
    const gen = f.gen ?? 0, left = f.ev.born + s.total - tick;
    if (left >= FIRE_STEP && hashUnit(key, f.part, f.part, tick) < surviveChance(s, beside[i], gen)) {
      const g = nextGen(s, f);
      f.gen = gen + 1; f.dps = g.dps; f.ticks = g.ticks; f.until = tick + Math.min(g.ticks, left);
      told?.(f, null);
    } else f.until = -1;
  }
  for (let i = 0; i < n0; i++) {
    const f = fires[i], s = f.fire;
    if (!s || !f.ev || f.until <= tick || tick % s.beat !== 0) continue;
    const gen = f.gen ?? 0, left = f.ev.born + s.total - tick;
    if (gen >= s.gens || left < FIRE_STEP) continue;
    const chance = spreadChance(s, beside[i], gen);
    for (const t of adj[f.part] ?? []) {
      if (f.ev.lit >= s.parts) break;
      if (!alive(t) || lit(t) || hashUnit(key, f.part, t, tick) >= chance) continue;
      const g = nextGen(s, f), c = make(f, t);
      c.part = t; c.fire = s; c.ev = f.ev; c.gen = gen + 1; c.dps = g.dps; c.ticks = g.ticks; c.until = tick + Math.min(g.ticks, left);
      f.ev.lit++;
      fires.push(c);
      told?.(c, f);
    }
  }
  // (what went out leaves the list)
  let w = 0;
  for (let i = 0; i < fires.length; i++) if (fires[i].until !== -1) fires[w++] = fires[i];
  fires.length = w;
}

/**
 * The parts a world-space segment meets after `first` on a ship at (px, py, angle), nearest first, up to `n`: the
 * layers behind the part a shot struck, along its line into the hull (castShipAt, with the parts found left out)
 */
export function partsBehind(geoms: readonly PlacedGeom[], ok: (i: number) => boolean, cellSize: number, com: Vec2, px: number, py: number, angle: number,
  x0: number, y0: number, x1: number, y1: number, first: number, n: number, margin = 0): number[] {
  const out: number[] = [];
  const skip = (i: number): boolean => i !== first && !out.includes(i) && ok(i);
  while (out.length < n) {
    const h = castShipAt(geoms, skip, cellSize, com, px, py, angle, x0, y0, x1, y1, margin);
    if (!h) break;
    out.push(h.part);
  }
  return out;
}

/** The parts joined to each part of a design (design.ts designOf: worked out once a blueprint) */
export function hullNeighbours(catalog: Catalog, bp: Blueprint): number[][] {
  return fireNeighbours(designOf(catalog, bp).joins, bp.parts.length);
}
