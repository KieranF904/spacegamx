/**
 * A far ship's motion in closed form (server ships/SimLod.ts flies distant
 * ships by it; the system map carries their dots on by it: client FarShips).
 *
 * A leg is where a ship was and how it was moving at the leg's start, and a
 * thrust held for `thrust` ticks that would take it to a top speed `w` (its
 * cruise, at its pace), after which it coasts. It's exactly flight's
 * integrator, v = (v + a) × FRICTION then x += v, with the thrust held:
 *
 *   C(t) = F (1 - F^t) / (1 - F)                 (how far a velocity carries in t ticks)
 *   x(t) = x0 + v0 C(t) + w (t - C(t))           (while thrusting)
 *   v(t) = v0 F^t + w (1 - F^t)
 *
 * and then x(t1) + v(t1) C(t - t1) coasting. The velocity it had dies away
 * while the new thrust builds, so a change of course is a rounded turn, and
 * the same leg gives the same place whenever (and however often) it's asked.
 */

import { FRICTION } from '../constants.js';
import { dcos, dhypot, dpow, dsin } from '../math/detTrig.js';

export interface Leg {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** The top speed its thrust would take it to (world units a tick, as a vector) */
  wx: number;
  wy: number;
  /** Ticks the thrust is held (then it coasts); -1: for good */
  thrust: number;
}

export interface Motion { x: number; y: number; vx: number; vy: number }

const F = FRICTION;
/** How far a velocity carries once nothing pushes it (in ticks of that velocity) */
export const CARRY = F / (1 - F);

/** Where a leg has it `t` ticks after it started */
export function legAt(l: Leg, t: number, out: Motion = { x: 0, y: 0, vx: 0, vy: 0 }): Motion {
  if (!(t > 0)) { out.x = l.x; out.y = l.y; out.vx = l.vx; out.vy = l.vy; return out; }
  const th = l.thrust < 0 ? t : Math.min(t, l.thrust);
  const Ft = dpow(F, th), c = CARRY * (1 - Ft);
  let x = l.x + l.vx * c + l.wx * (th - c), y = l.y + l.vy * c + l.wy * (th - c);
  let vx = l.vx * Ft + l.wx * (1 - Ft), vy = l.vy * Ft + l.wy * (1 - Ft);
  if (t > th) {
    const Fc = dpow(F, t - th), k = CARRY * (1 - Fc);
    x += vx * k; y += vy * k;
    vx *= Fc; vy *= Fc;
  }
  out.x = x; out.y = y; out.vx = vx; out.vy = vy;
  return out;
}

/** The same motion as a leg starting `t` ticks into this one */
export function legFrom(l: Leg, t: number): Leg {
  const m = legAt(l, t);
  const left = l.thrust < 0 ? -1 : Math.max(0, l.thrust - Math.max(0, t));
  return { x: m.x, y: m.y, vx: m.vx, vy: m.vy, wx: left === 0 ? 0 : l.wx, wy: left === 0 ? 0 : l.wy, thrust: left };
}

/** Engines off from here: it coasts to a stop */
export function coastLeg(m: Motion): Leg {
  return { x: m.x, y: m.y, vx: m.vx, vy: m.vy, wx: 0, wy: 0, thrust: 0 };
}

/**
 * From where it is, to come to rest at (tx, ty) at top speed `speed`: thrust
 * aimed past the point by however far its velocity now would carry it
 * sideways, held for as long as it takes to cover the rest at that speed
 * (with that thrust it comes to rest exactly there: x0 + v0 CARRY + w t1)
 */
export function legTo(m: Motion, tx: number, ty: number, speed: number): Leg {
  const dx = tx - m.x - m.vx * CARRY, dy = ty - m.y - m.vy * CARRY, d = dhypot(dx, dy);
  if (!(speed > 0) || d < 1) return coastLeg(m);
  return { x: m.x, y: m.y, vx: m.vx, vy: m.vy, wx: (dx / d) * speed, wy: (dy / d) * speed, thrust: d / speed };
}

/**
 * The first tick (from the leg's start) it's within `arrive` of (tx, ty), or
 * -1 if it never is: looked for a quarter second at a time, then narrowed down
 */
export function legArrival(l: Leg, tx: number, ty: number, arrive: number): number {
  const m: Motion = { x: 0, y: 0, vx: 0, vy: 0 };
  const within = (t: number) => { legAt(l, t, m); return dhypot(m.x - tx, m.y - ty) <= arrive; };
  if (within(0)) return 0;
  // (It's at rest within a few CARRYs of its thrust ending: nothing changes after)
  const last = (l.thrust < 0 ? 60 * 60 * 30 : l.thrust) + CARRY * 6;
  let lo = 0;
  for (let t = 15; ; t += 15) {
    const at = Math.min(t, last);
    if (within(at)) {
      let hi = at;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (within(mid)) hi = mid; else lo = mid; }
      return hi;
    }
    if (at >= last) return -1;
    lo = at;
  }
}

/** A leg is never shorter than this (ticks) */
export const MIN_LEG = 30;
/** How close a patrol comes to each of its points before it turns for the next */
export const PATROL_ARRIVE = 300;

/** The dice routes roll (a 32-bit LCG, the same on every machine) */
export function nextSeed(seed: number): number {
  return (Math.imul(seed, 1664525) + 1013904223) >>> 0;
}

/**
 * A patrol round a home that stays put (a hostile's: server SimLod, and the
 * map's dots: client FarShips): from point to point at random 600 to `roam`
 * out from (hx, hy), at top speed `speed`, coming within PATROL_ARRIVE of
 * each. Its points come from its dice and every leg starts from a rounded
 * place, so the server and the map work it out alike and the map is told it
 * once (the numbers are kept as they're sent: patrolOf)
 */
export interface Patrol { hx: number; hy: number; roam: number; speed: number }

/** Where a patrol is on its way, from tick t0: from `from` to (tx, ty), the leg that is, until `end`; its dice */
export interface PatrolState { t0: number; from: Motion; tx: number; ty: number; leg: Leg; end: number; seed: number }

const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** A patrol's numbers as they're sent */
export function patrolOf(hx: number, hy: number, roam: number, speed: number): Patrol {
  return { hx: r2(hx), hy: r2(hy), roam: Math.max(601, Math.round(roam)), speed: r4(speed) };
}

/** Its next point, and its dice after */
export function patrolPoint(p: Patrol, seed: number): { x: number; y: number; seed: number } {
  const s1 = nextSeed(seed), s2 = nextSeed(s1);
  const a = (s1 / 4294967296) * Math.PI * 2, r = 600 + (s2 / 4294967296) * (p.roam - 600);
  return { x: r2(p.hx + dcos(a) * r), y: r2(p.hy + dsin(a) * r), seed: s2 };
}

/** Under way from `from` (rounded here, as it's sent) at tick t0 for (tx, ty) */
export function patrolFrom(p: Patrol, t0: number, from: Motion, tx: number, ty: number, seed: number): PatrolState {
  const m = { x: r2(from.x), y: r2(from.y), vx: r4(from.vx), vy: r4(from.vy) };
  const x = r2(tx), y = r2(ty);
  const leg = legTo(m, x, y, p.speed);
  const arr = legArrival(leg, x, y, PATROL_ARRIVE);
  const end = t0 + Math.ceil(Math.max(MIN_LEG, arr < 0 ? leg.thrust + CARRY * 3 : arr));
  return { t0, from: m, tx: x, ty: y, leg, end, seed };
}

/** On to its next leg, from where this one ends */
export function patrolNext(p: Patrol, s: PatrolState): PatrolState {
  const at = legAt(s.leg, s.end - s.t0), pt = patrolPoint(p, s.seed);
  return patrolFrom(p, s.end, at, pt.x, pt.y, pt.seed);
}
