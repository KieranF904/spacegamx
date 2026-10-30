/**
 * Ship energy: generators, batteries, and what draws on them.
 *
 * Three pools of stored energy:
 *   general   the core's own battery plus standard batteries: serves everything
 *   drive     drive batteries: engines only
 *   weapon    weapon batteries: guns and mining lasers only
 * (better grades of battery hold more). Steady loads (shields, scanners, jump
 * coils) take the generators' power first (rebuild.ts); what's left over is
 * the spare power, and each tick:
 *
 *   1. Engines come first. Thrusting, they take the spare power as it streams
 *      in; what that doesn't cover comes from the drive batteries, then the
 *      general one (boosting draws far more, and needs stored charge). With
 *      both dry, they push only as hard as the spare power allows.
 *   2. Whatever spare power the engines leave charges the pools, each in
 *      proportion to how empty it is.
 *   3. Guns spend a packet of stored energy per shot (beams: per tick), from
 *      the weapon batteries, then the general one; a gun the batteries can't
 *      pay for waits. Mining lasers pay for a quarter-second segment at a time
 *      (MINE_SEGMENT ticks, aligned to the tick count) the same way: no charge,
 *      no beam. So guns and lasers never take power the engines are using:
 *      thrusting on empty batteries, they're silent.
 *
 * Charge travels (and is predicted) as a percentage of each pool's capacity.
 * The same steps run on the server and on the pilot's client.
 */

import type { ShipDerived } from './rebuild.js';
import type { ShipTuning } from './tuning.js';

export interface EnergyInfo {
  /** Capacity of each pool (energy units: power × seconds): general, drive (engines only), weapon (guns and lasers only) */
  max: number;
  driveMax: number;
  weaponMax: number;
  /** Generator power left after the steady loads (power units: per second) */
  spare: number;
  /** Total generator power */
  supply: number;
  /** What the engines draw at full thrust, and the mining lasers while mining (per second) */
  engineDraw: number;
  minerDraw: number;
  /** What the guns draw firing flat out (per second), for ratings and the hangar */
  weaponDraw: number;
}

/** Each pool's charge, as a percentage of its capacity */
export interface Charge { g: number; d: number; w: number }

export const FULL_CHARGE: Charge = { g: 100, d: 100, w: 100 };
/** Mining lasers run (and are paid for) in segments this many ticks long */
export const MINE_SEGMENT = 15;
/** A mining laser's pulse (ticks): once started it runs to its end, whether or not the button's still held; it just isn't followed by another */
export const MINE_CYCLE = 54;

export const ENERGY_DEFAULTS = { coreCapacity: 240, boostDraw: 2.8 };

/** Each tuning's energy settings, worked out once (this runs for every ship every tick) */
const energyTunings = new WeakMap<ShipTuning, typeof ENERGY_DEFAULTS>();

export function energyTuning(t: ShipTuning): typeof ENERGY_DEFAULTS {
  let e = energyTunings.get(t);
  if (!e) energyTunings.set(t, (e = { ...ENERGY_DEFAULTS, ...((t as { energy?: Partial<typeof ENERGY_DEFAULTS> }).energy ?? {}) }));
  return e;
}

const pct = (v: number, max: number) => (max <= 0 ? 0 : Math.round(Math.max(0, Math.min(100, (v / max) * 100)) * 1000) / 1000);

/** Energy held in each pool (absolute) */
function held(d: ShipDerived, c: Charge): { g: number; d: number; w: number } {
  const e = d.energy;
  return { g: (e.max * c.g) / 100, d: (e.driveMax * c.d) / 100, w: (e.weaponMax * c.w) / 100 };
}

function toCharge(d: ShipDerived, h: { g: number; d: number; w: number }): Charge {
  const e = d.energy;
  return { g: pct(h.g, e.max), d: pct(h.d, e.driveMax), w: pct(h.w, e.weaponMax) };
}

/** All the ship's stored energy as one percentage (the HUD's gauge) */
export function chargeTotal(d: ShipDerived, c: Charge): number {
  const e = d.energy;
  const max = e.max + e.driveMax + e.weaponMax;
  const h = held(d, c);
  return max <= 0 ? 0 : Math.round(((h.g + h.d + h.w) / max) * 1000) / 10;
}

/** Energy available to engines, or to guns and lasers */
export function storedFor(d: ShipDerived, c: Charge, use: 'drive' | 'weapon'): number {
  const h = held(d, c);
  return h.g + (use === 'drive' ? h.d : h.w);
}

export interface PowerUse {
  thrusting: boolean;
  boosting: boolean;
}

/**
 * One tick of the engines and the charging (steps 1 and 2 above). Returns the
 * new charge, how much of their power the engines got (1 unless they ran on
 * empty), and whether a boost was possible (it needs stored charge).
 */
export function powerTick(d: ShipDerived, c: Charge, use: PowerUse, tuning: ShipTuning): { charge: Charge; power: number; boost: boolean } {
  const e = d.energy;
  if (!e) return { charge: c, power: 1, boost: use.boosting };
  const et = energyTuning(tuning);
  const h = held(d, c);
  const boost = use.boosting && use.thrusting && h.d + h.g > 0;
  const need = use.thrusting ? (e.engineDraw * (boost ? 1 + et.boostDraw * (d.boostDrain ?? 1) : 1)) / 60 : 0;
  const stream = e.spare / 60;
  let power = 1;
  if (stream >= need) {
    // The engines are covered: the rest charges the pools, the emptiest most
    let left = stream - need;
    const room = { g: e.max - h.g, d: e.driveMax - h.d, w: e.weaponMax - h.w };
    const total = room.g + room.d + room.w;
    if (left > 0 && total > 0) {
      const k = Math.min(1, left / total);
      h.g += room.g * k; h.d += room.d * k; h.w += room.w * k;
      left = 0;
    }
  } else {
    // Short: the drive batteries, then the general one, make up the rest; dry, the engines get what streams in
    let short = need - stream;
    const fromD = Math.min(h.d, short); h.d -= fromD; short -= fromD;
    const fromG = Math.min(h.g, short); h.g -= fromG; short -= fromG;
    if (short > 1e-9) power = Math.max(0, Math.min(1, (need - short) / need));
  }
  return { charge: toCharge(d, h), power, boost };
}

/** Spend `cost` stored energy on a gun or laser (weapon batteries, then general): the new charge, or null if they can't pay */
export function spend(d: ShipDerived, c: Charge, cost: number): Charge | null {
  if (cost <= 0 || !d.energy) return c;
  const h = held(d, c);
  if (h.w + h.g + 1e-9 < cost) return null;
  const fromW = Math.min(h.w, cost);
  h.w -= fromW;
  h.g = Math.max(0, h.g - (cost - fromW));
  return toCharge(d, h);
}

/**
 * Mining lasers, one tick: they run a segment (MINE_SEGMENT ticks, aligned to
 * the tick count) at a time, paying for it as it starts (or for what's left of
 * it, starting mid-way). Returns whether the beams are on this tick; `c.charge`
 * and `ship.minePaid` (the segment paid for) are updated.
 */
export function payMining(ship: { derived: ShipDerived; minePaid?: number; mineUntil?: number }, on: boolean, tick: number, c: { charge: Charge }): boolean {
  if (!ship.derived.miners.length) return false;
  const running = tick < (ship.mineUntil ?? 0);
  if (!on && !running) return false;
  if (!running) ship.mineUntil = tick + MINE_CYCLE;
  const seg = Math.floor(tick / MINE_SEGMENT);
  if (ship.minePaid === seg) return true;
  const ticks = MINE_SEGMENT - (tick % MINE_SEGMENT);
  const left = spend(ship.derived, c.charge, (ship.derived.energy.minerDraw * ticks) / 60);
  if (!left) { ship.mineUntil = 0; return false; }
  c.charge = left;
  ship.minePaid = seg;
  return true;
}
