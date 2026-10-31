/**
 * The Burst Strafer (a part: functions `strafe`; docs/design/build-archetypes.md §5 #1): a side thruster that
 * gives nothing for cruising, only a dodge. The pilot asks for a dodge to one side (left or right of the ship), and
 * every powered strafer pushing that way fires one sharp burst, a fixed `ticks` long, then a charge is spent and
 * refills over `recharge` ticks. A ship holds `charges` of them.
 *
 * Its whole state is two numbers on the flight body, stepped from the pilot's held dodge control, so it rides
 * snapshots and keyframes and prediction replays it exactly (like the jump drive's and the anchor's counters):
 *
 *   dodge       0                       ready
 *               ±1 .. ±ticks            a burst under way (the sign is its side: - left, + right)
 *               ±(ticks + 1)            done, waiting for the control to be let go (one dodge a press)
 *   dodgeSpent  ticks of charge spent: each burst adds `recharge`, one comes back a tick; a burst needs a whole
 *               charge free (spent + recharge <= charges × recharge)
 *
 * Energy: while a burst runs its strafers draw their `demand` (a lot), from the capacitor bank they touch first,
 * then their circuit like an engine (energy.ts PowerUse.dodge). Short of it, the burst pushes that much less.
 * Mass matters: the push is a force, so a heavy ship barely moves (flight.ts).
 */

import type { ShipDerived } from './rebuild.js';
import { CHARGE_GROUPS_AT, MAX_CHARGE_GROUPS } from './energy.js';

/** One strafer's sideways push (force, as an engine's thrust: world units of acceleration × mass) */
export interface StraferPart {
  part: number;
  force: number;
}

/** What a ship's strafers give (ShipDerived.strafe): per side, and the shared charges */
export interface StrafeInfo {
  /** Strafers pushing the ship left (ship-local -x) and right (+x) */
  left: StraferPart[];
  right: StraferPart[];
  /** A burst's length (ticks), how many the ship holds, and ticks to refill one (the best fitted strafer's) */
  ticks: number;
  charges: number;
  recharge: number;
}

/** A strafer needs to point at least this much sideways to dodge */
export const STRAFE_SIDEWAYS = 0.5;

export type DodgePhase = 'ready' | 'burst' | 'held';

/** Where a dodge counter is: its phase, side (-1 left, +1 right, 0 none) and progress through a burst (0..1) */
export function dodgePhase(c: number | undefined, ticks: number): { phase: DodgePhase; side: number; progress: number } {
  const v = c ?? 0, k = Math.abs(v), side = Math.sign(v);
  if (k === 0) return { phase: 'ready', side: 0, progress: 1 };
  if (k <= ticks) return { phase: 'burst', side, progress: k / ticks };
  return { phase: 'held', side, progress: 1 };
}

/** The sideways push to one side (-1 left, +1 right), all its strafers together */
export function strafeForce(s: StrafeInfo | undefined, side: number): number {
  if (!s || !side) return 0;
  let f = 0;
  for (const p of side < 0 ? s.left : s.right) f += p.force;
  return f;
}

/** Charges ready (whole) and how far the next one has refilled (0..1), from the charge spent */
export function dodgeCharges(s: StrafeInfo | undefined, spent: number | undefined): { ready: number; max: number; refill: number } {
  if (!s || s.charges <= 0) return { ready: 0, max: 0, refill: 0 };
  const left = Math.max(0, s.charges * s.recharge - (spent ?? 0));
  const ready = Math.floor(left / s.recharge);
  return { ready, max: s.charges, refill: ready >= s.charges ? 1 : (left - ready * s.recharge) / s.recharge };
}

/** Can the ship start a dodge to this side now (charge free, strafers that way, not mid-burst) */
export function canDodge(s: StrafeInfo | undefined, side: number, dodge: number | undefined, spent: number | undefined): boolean {
  return !!s && !!side && (dodge ?? 0) === 0 && strafeForce(s, side) > 0 && (spent ?? 0) + s.recharge <= s.charges * s.recharge;
}

/**
 * One tick of the dodge (flight.ts runs it): `want` the pilot's dodge control (-1 left, +1 right, 0 none),
 * `blocked` the drive busy (a jump spooling, the anchor out). Updates the body's counter and charge, and returns
 * the side a burst pushes this tick (0: none).
 */
export function stepDodge(body: { dodge?: number; dodgeSpent?: number }, want: number, s: StrafeInfo | undefined, blocked: boolean): number {
  let c = body.dodge ?? 0;
  let spent = Math.max(0, (body.dodgeSpent ?? 0) - 1);
  const k = Math.abs(c), side = Math.sign(c), w = Math.sign(want);
  let out = 0;
  if (!s) c = 0;
  else if (k === 0) {
    if (w && !blocked && strafeForce(s, w) > 0 && spent + s.recharge <= s.charges * s.recharge) {
      c = w; spent += s.recharge; out = w;
    }
  } else if (k < s.ticks) { c = side * (k + 1); out = side; }
  // (Done: held until the control's let go, or asked the other way)
  else c = w === side ? side * (s.ticks + 1) : 0;
  body.dodge = c || undefined;
  body.dodgeSpent = spent || undefined;
  return out;
}

/** What a burst to `side` asks of each feed group (per second: energy.ts PowerUse.dodge), or undefined */
export function dodgeLoad(d: ShipDerived, side: number): number[] | undefined {
  const L = d.power, s = d.strafe;
  if (!L || !s || !side) return undefined;
  const out = new Array<number>(L.feeds.length).fill(0);
  let any = false;
  for (const p of side < 0 ? s.left : s.right) {
    const f = L.feedOf[p.part];
    if (f >= 0) { out[f] += L.draw[p.part]; any = true; }
  }
  return any ? out : undefined;
}

/** Energy one burst to `side` costs (every strafer firing that way), for readouts */
export function burstEnergy(d: ShipDerived, side: number): number {
  const L = d.power, s = d.strafe;
  if (!L || !s) return 0;
  let e = 0;
  for (const p of side < 0 ? s.left : s.right) e += (L.draw[p.part] * s.ticks) / 60;
  return e;
}

/**
 * The pilot's own snapshot row carries, after the charge groups (energy.ts CHARGE_GROUPS_AT + data[11]): the dodge
 * counter, the charge spent, and what the Tow Beam tows (entity id + 1, 0 nothing). GameServer writes them in that order.
 */
export function pilotExtras(data: number[] | undefined): { dodge: number; dodgeSpent: number; tow: number } {
  if (!data || data.length <= 11) return { dodge: 0, dodgeSpent: 0, tow: 0 };
  const at = CHARGE_GROUPS_AT + Math.max(0, Math.min(MAX_CHARGE_GROUPS, data[11] | 0));
  return { dodge: data[at] ?? 0, dodgeSpent: data[at + 1] ?? 0, tow: data[at + 2] ?? 0 };
}
