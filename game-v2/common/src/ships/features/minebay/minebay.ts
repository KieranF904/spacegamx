/**
 * The Mine Bay's rules (docs/design/groups-mines-docking.md, "Mine bay"): not an aimed or targetable weapon. A key press
 * drops a batch of proximity mines out of the bay's open edge. Every number here is a starting point to playtest.
 *
 * Deterministic: a drop is one decision record (MineDrop: where the bay's mouth was, which way it faced, the ship's
 * velocity, the tick, a seed), and everything about its mines (where each slides to and stops, when it arms, when it
 * expires) is worked out from that record alone, with exact arithmetic (+ - x / and the deterministic trig), so the
 * server and every client agree with nothing streamed. Pure: no state, no allocation in the per-tick queries.
 */

import { datan2, dsincos } from '../../../math/detTrig.js';
import { wrapPi } from '../../../math/basic.js';
import { hashInts } from '../../../math/rng.js';
import type { FunctionDef } from '../../types.js';

/** The mines' own numbers (a Mine Bay part's batch, magazine and cooldown are its model's: FunctionDef.mineBay) */
export const MINES = Object.freeze({
  /** Ticks after the drop before a mine can go off */
  armTicks: 60,
  /** Ticks a mine lasts, then it fizzles out (90 s) */
  lifeTicks: 90 * 60,
  /** A ship's hull (its bounding circle) this close to an armed mine sets it off (world units) */
  triggerReach: 40,
  /** The blast: radius and damage at its centre (through the normal damage funnel: falloff, shields, armour) */
  blastRadius: 110,
  blastDamage: 140,
  /** Live mines a pilot may have out at once; a drop past it takes the oldest away first (they fizzle) */
  capPerPilot: 24,
  /** How a batch leaves the bay: speed out of the mouth, the share of the ship's velocity it keeps, the fan between mines (radians) */
  ejectSpeed: 3,
  inherit: 0.5,
  spread: 0.35,
  /** A mine slows evenly to rest over this many ticks (it then sits still: no gravity, no drift) */
  slideTicks: 40,
  /** Extra eject speed each mine may get at random from the drop's seed, as a share of ejectSpeed (so a batch doesn't stack) */
  jitter: 0.25,
});

/** A model's mine bay, cleaned (absent: not a mine bay) */
export function mineBayOf(fn: FunctionDef): { batch: number; capacity: number; cooldown: number } | null {
  const m = fn.mineBay;
  if (!m) return null;
  const whole = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(v) ? v : lo)));
  return { batch: whole(m.batch, 1, 8), capacity: whole(m.capacity, 1, 64), cooldown: whole(m.cooldown, 1, 3600) };
}

/** What a rebuild derives for a ship with a working Mine Bay (`derived.fx.minebay`) */
export interface MineBayInfo {
  /** Each working bay, in part order: its part index and uid, model numbers, and its mouth (grid units) and outward way (grid frame) */
  bays: { part: number; uid: number; batch: number; capacity: number; cooldown: number; mouth: [number, number]; dir: [number, number] }[];
}

declare module '../types.js' {
  interface FeatureDerived { minebay?: MineBayInfo }
}

/**
 * One drop: the decision record every end derives the batch from (the server sends it as `minesLaid`). Positions in
 * world units, rounded to 2 decimals; the way out as an angle rounded to 5 (the ship snapshot precision)
 */
export interface MineDrop {
  /** The dropping pilot's ship (entity id) and the bay's blueprint uid */
  owner: number;
  bay: number;
  /** The tick the mines leave the bay */
  tick: number;
  /** How many mines (the bay's batch, or fewer: what the magazine had) */
  n: number;
  /** The bay's mouth in the world, and the world angle it faces out along */
  x: number;
  y: number;
  angle: number;
  /** The ship's velocity at the drop (world units a tick) */
  vx: number;
  vy: number;
  /** The drop's seed (server-chosen: hashInts of owner, bay, tick) */
  seed: number;
}

/** The seed a drop gets (both ends could work it out; the record carries it so they need not) */
export const dropSeed = (owner: number, bay: number, tick: number): number => hashInts(0x6d696e65, owner, bay, tick) >>> 0;

/** A mine's name: unique per pilot and tick (owner up to 2^24, the tick's low 24 bits, the batch index under 16) */
export function mineId(owner: number, tick: number, i: number): number {
  return owner * 2 ** 28 + (tick & 0xffffff) * 16 + (i & 15);
}
export function mineIdParts(id: number): { owner: number; tick24: number; i: number } {
  const owner = Math.floor(id / 2 ** 28), rest = id - owner * 2 ** 28;
  return { owner, tick24: Math.floor(rest / 16), i: rest % 16 };
}

/** Mine i of a drop: its start and launch velocity (world). Exact arithmetic only */
export function mineLaunch(d: Readonly<MineDrop>, i: number, out: { x: number; y: number; vx: number; vy: number } = { x: 0, y: 0, vx: 0, vy: 0 }): typeof out {
  const fan = d.n > 1 ? (i - (d.n - 1) / 2) * MINES.spread : 0;
  const sc = dsincos(d.angle + fan, SC);
  // (A seeded bit of extra speed per mine: the seed's bits, no float randomness)
  const j = ((hashInts(d.seed, i) >>> 0) % 1024) / 1023;
  const speed = MINES.ejectSpeed * (1 + MINES.jitter * j);
  out.x = d.x; out.y = d.y;
  out.vx = d.vx * MINES.inherit + sc[1] * speed;
  out.vy = d.vy * MINES.inherit + sc[0] * speed;
  return out;
}
const SC: [number, number] = [0, 0];
const L = { x: 0, y: 0, vx: 0, vy: 0 };

/**
 * Where mine i of a drop is at `tick` (world units, rounded to 2 decimals as ships are): it slides out, slowing evenly,
 * and stops after slideTicks. Before the drop: at the mouth
 */
export function minePos(d: Readonly<MineDrop>, i: number, tick: number, out: [number, number] = [0, 0]): [number, number] {
  mineLaunch(d, i, L);
  const T = MINES.slideTicks, a = Math.max(0, Math.min(T, tick - d.tick));
  // (Distance under an even slowing to rest over T ticks: v0 (a - a^2 / 2T))
  const s = a - (a * a) / (2 * T);
  out[0] = Math.round((L.x + L.vx * s) * 100) / 100;
  out[1] = Math.round((L.y + L.vy * s) * 100) / 100;
  return out;
}

/** Armed at `tick` (and not yet expired) */
export const mineArmed = (d: Readonly<MineDrop>, tick: number): boolean => tick - d.tick >= MINES.armTicks && !mineExpired(d, tick);
/** Past its life (it fizzles on that tick) */
export const mineExpired = (d: Readonly<MineDrop>, tick: number): boolean => tick - d.tick >= MINES.lifeTicks;

/**
 * Does a ship (its centre and bounding radius, world units) set the mine off? Only an armed mine, and never its owner
 * or a ship the caller counts as safe (the owner's party: the caller decides who is safe and passes only the others)
 */
export function mineTouches(mx: number, my: number, x: number, y: number, radius: number): boolean {
  const dx = x - mx, dy = y - my, r = radius + MINES.triggerReach;
  return dx * dx + dy * dy <= r * r;
}

// ============================================ the drop (server decides it; the dropping pilot's client predicts it the same way)

/** A ship's pose and velocity at a drop: its centre of mass in the world (as Position is), heading and velocity a tick */
export interface DropPose { x: number; y: number; angle: number; vx: number; vy: number }

const r2 = (v: number) => Math.round(v * 100) / 100;
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
const SC2: [number, number] = [0, 0];

/** A grid-frame direction's angle from the ship's forward (grid -y): exact for the four facings, atan2 otherwise */
function localAngle(dx: number, dy: number): number {
  if (dx === 0) return dy < 0 ? 0 : Math.PI;
  if (dy === 0) return dx > 0 ? Math.PI / 2 : -Math.PI / 2;
  return datan2(dx, -dy);
}


/**
 * The drop record for a batch of `n` from `bay` (one of fx.minebay.bays) of a ship at `pose`, on `tick`. `com`: the
 * ship's centre of mass in grid units (derived.com), `cellSize` the world units a grid unit. The same arithmetic as the
 * ship's grid-to-world (flight.ts localToWorldDir), rounded as the record carries it
 */
export function makeDrop(
  owner: number, bay: Readonly<MineBayInfo['bays'][number]>, tick: number, n: number,
  com: readonly [number, number] | readonly number[], cellSize: number, pose: Readonly<DropPose>,
): MineDrop {
  const lx = (bay.mouth[0] - com[0]) * cellSize, ly = (bay.mouth[1] - com[1]) * cellSize;
  dsincos(pose.angle + Math.PI / 2, SC2);
  const s = SC2[0], c = SC2[1];
  return {
    owner, bay: bay.uid, tick, n,
    x: r2(pose.x + lx * c - ly * s), y: r2(pose.y + lx * s + ly * c),
    angle: r5(wrapPi(pose.angle + localAngle(bay.dir[0], bay.dir[1]))),
    vx: r2(pose.vx), vy: r2(pose.vy),
    seed: dropSeed(owner, bay.uid, tick),
  };
}

/** A bay's loaded mines from the magazine table (by uid), whole and within its capacity */
export function bayLoaded(bay: Readonly<{ uid: number; capacity: number }>, loaded: Readonly<Record<number, number>> | undefined): number {
  const v = loaded?.[bay.uid] ?? 0;
  return Math.max(0, Math.min(bay.capacity, Number.isFinite(v) ? Math.floor(v) : 0));
}

/**
 * Which bay a press drops from on `tick` (its index in info.bays; -1: none can): the fullest one that has mines and
 * whose cooldown is over (`readyBy`: the tick each bay may drop again, by uid), ties to the first in part order
 */
export function pickBay(
  info: Readonly<MineBayInfo> | undefined, loaded: Readonly<Record<number, number>> | undefined,
  readyBy: Readonly<Record<number, number>> | undefined, tick: number,
): number {
  if (!info) return -1;
  let best = -1, most = 0;
  for (let i = 0; i < info.bays.length; i++) {
    const b = info.bays[i], n = bayLoaded(b, loaded);
    if (n <= 0 || tick < (readyBy?.[b.uid] ?? -Infinity)) continue;
    if (n > most) { most = n; best = i; }
  }
  return best;
}

/** The earliest tick any loaded bay can drop (Infinity: none has mines) */
export function nextReady(info: Readonly<MineBayInfo> | undefined, loaded: Readonly<Record<number, number>> | undefined, readyBy: Readonly<Record<number, number>> | undefined): number {
  let at = Infinity;
  for (const b of info?.bays ?? []) if (bayLoaded(b, loaded) > 0) at = Math.min(at, readyBy?.[b.uid] ?? 0);
  return at;
}

/** Magazine refills (econ/field/rules.ts REARM): how many mines the bays of a ship still lack, from each bay's loaded count */
export function minesMissing(info: Readonly<MineBayInfo> | undefined, loaded: Readonly<Record<number, number>> | undefined): number {
  if (!info) return 0;
  let n = 0;
  for (const b of info.bays) n += Math.max(0, b.capacity - Math.max(0, Math.floor(loaded?.[b.uid] ?? 0)));
  return n;
}
