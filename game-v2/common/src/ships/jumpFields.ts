/**
 * Jump-drive charging fields: a star's charging ring (round the system centre)
 * and stillstones' (systems.json `lodestones`, "lodestones" in the code: huge
 * grey bodies orbiting slowly, or a few fixed ones). Inside either, the drive
 * cools down faster. A stillstone also primes the drive: the next jump within
 * a minute of leaving reaches further. The two don't add up: together you get
 * the better of each. A stillstone's field reaches jump.lodestoneField past
 * its surface; a scarred one gives a share of the bonus, a dead or shattered
 * one none (it has no field at all).
 *
 * Positions come from the tick and distances are compared squared, so the
 * server, the pilot's prediction and every replica land on the same answer.
 * A fractional charge (a scarred stone's) is counted in whole ticks by the
 * tick number, and a scarred stone's priming is kept negative, so all of it
 * stays whole numbers on every side.
 */

import type { LodestoneData } from '../data/schemas.js';
import { planetPosition } from '../world/planets.js';
import { inSolarRing, type JumpTuning } from './flight.js';

/** Where a system's fields are */
export interface FieldEnv {
  /** The central body (its charging ring) */
  central: { type?: string; radius?: number } | null | undefined;
  lodestones?: readonly LodestoneData[];
}

/** The fields at a point */
export interface JumpField {
  /** In the star's charging ring */
  ring: boolean;
  /** In this stillstone's field */
  lodestone: LodestoneData | null;
}

export const NO_FIELD: JumpField = Object.freeze({ ring: false, lodestone: null });
/** Nowhere with fields */
export const NO_FIELDS: FieldEnv = Object.freeze({ central: null });

/** Where a lodestone is at a tick (whole units) */
export function lodestonePosition(l: LodestoneData, tick: number): { x: number; y: number } {
  if (l.orbit) {
    const p = planetPosition({ orbit: l.orbit }, tick);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }
  return { x: l.position?.x ?? 0, y: l.position?.y ?? 0 };
}

/** What a lodestone is called */
export function lodestoneName(l: LodestoneData, t: JumpTuning): string {
  return l.name ?? t.lodestoneName;
}

/** What the map and markers call it: a dead or shattered one says so ("Dead stillstone") */
export function lodestoneLabel(l: LodestoneData, t: JumpTuning): string {
  if (lodestoneLive(l)) return lodestoneName(l, t);
  return l.name ? `${l.name} (${l.state})` : `${l.state === 'dead' ? 'Dead' : 'Shattered'} ${t.lodestoneName.toLowerCase()}`;
}

/** How far short of its centre a jump locked on to it lands: inside its field, off the stone (beside it, with no field) */
export function lodestoneStop(l: LodestoneData, t: JumpTuning): number {
  return Math.round(lodestoneLive(l) ? lodestoneFieldRadius(l, t) - t.lodestoneField * 0.5 : lodestoneSize(l, t) + 600);
}

/** How big it is (its radius) */
export function lodestoneSize(l: LodestoneData, t: JumpTuning): number {
  return l.size ?? t.lodestoneSize;
}

/** Does it still have a field (not dead or shattered) */
export function lodestoneLive(l: LodestoneData): boolean {
  return l.state !== 'dead' && l.state !== 'shattered';
}

/** Its charging field's radius from its centre (0: none) */
export function lodestoneFieldRadius(l: LodestoneData, t: JumpTuning): number {
  return lodestoneLive(l) ? lodestoneSize(l, t) + t.lodestoneField : 0;
}

/** Extra cooldown ticks per tick in its field (a scarred one's can be a fraction) */
export function lodestoneChargeOf(l: LodestoneData, t: JumpTuning): number {
  if (!lodestoneLive(l)) return 0;
  return l.state === 'scarred' ? t.lodestoneCharge * t.lodestoneScarredCharge : t.lodestoneCharge;
}

/** The range multiplier a drive primed by it gets */
export function lodestoneBoostOf(l: LodestoneData, t: JumpTuning): number {
  if (!lodestoneLive(l)) return 1;
  return primeBoost(l.state === 'scarred' ? -1 : 1, t);
}

/** The lodestone whose field (x, y) is in, if any */
export function lodestoneAt(x: number, y: number, list: readonly LodestoneData[] | undefined, tick: number, t: JumpTuning): LodestoneData | null {
  if (!list?.length) return null;
  for (const l of list) {
    const r = lodestoneFieldRadius(l, t);
    if (!r) continue;
    const p = lodestonePosition(l, tick);
    const dx = x - p.x, dy = y - p.y;
    if (dx * dx + dy * dy < r * r) return l;
  }
  return null;
}

export function jumpFieldAt(x: number, y: number, env: FieldEnv, tick: number, t: JumpTuning): JumpField {
  const ring = inSolarRing(x, y, env.central, t);
  const lodestone = lodestoneAt(x, y, env.lodestones, tick, t);
  return ring || lodestone ? { ring, lodestone } : NO_FIELD;
}

/** Extra cooldown ticks counted per tick here: the better field's (they don't add up; a scarred stone's may be a fraction) */
export function fieldCharge(f: JumpField, t: JumpTuning): number {
  return Math.max(f.ring ? t.solarCharge : 0, f.lodestone ? lodestoneChargeOf(f.lodestone, t) : 0);
}

/** A charge of `c` a tick in whole ticks: what tick `tick` adds (0.5 adds one every other tick) */
export function wholeTicks(c: number, tick: number): number {
  return Math.floor((tick + 1) * c) - Math.floor(tick * c);
}

/** A primed drive's range multiplier: `primed` ticks left (negative: primed by a scarred stillstone) */
export function primeBoost(primed: number, t: JumpTuning): number {
  return primed > 0 ? t.lodestoneRangeBoost : primed < 0 ? 1 + (t.lodestoneRangeBoost - 1) * t.lodestoneScarredBoost : 1;
}

/** Jump range multiplier: the ring's, or a primed drive's (`primed`: ticks left, as stepPrime keeps it); in both, no more than the better of them */
export function fieldRangeBoost(ring: boolean, primed: number, t: JumpTuning): number {
  return Math.max(ring ? t.solarRangeBoost : 1, primeBoost(primed, t));
}

/**
 * After a pilot's flight step: a field speeds the drive's cooldown (`cool` is
 * the ship's own cooldown; jump coils change it). `tick` is the tick stepped
 * into (it counts a fractional charge out in whole ticks). Returns the new counter.
 */
export function fieldCooldown(jump: number, cool: number, f: JumpField, t: JumpTuning, tick = 0): number {
  const extra = wholeTicks(fieldCharge(f, t), tick);
  if (!extra || jump < t.chargeTicks + t.burnTicks) return jump;
  return jump + extra >= t.chargeTicks + t.burnTicks + cool ? 0 : jump + extra;
}

/**
 * The drive's priming after a step (ticks left): full inside a stillstone's
 * field, running down outside it, and spent by a jump (nor topped up during
 * one, as the burn carries you out). A scarred stone's priming is kept as
 * negative ticks, running up to 0 (it reaches less far: primeBoost).
 */
export function stepPrime(primed: number, jump: number, f: JumpField, t: JumpTuning): number {
  if (jump >= t.chargeTicks && jump < t.chargeTicks + t.burnTicks) return 0;
  if (f.lodestone) return f.lodestone.state === 'scarred' ? -t.lodestonePrimeTicks : t.lodestonePrimeTicks;
  return primed > 0 ? primed - 1 : primed < 0 ? primed + 1 : 0;
}

/**
 * A pilot's ship round its flight step, exactly as the server runs it
 * (ShipBridge.stepMovement) and the pilot's prediction does (ShipClient.predict):
 * `step` flies the tick with the range boost from where it starts; then the
 * fields where it ended speed the cooldown and prime the drive. `tick` is the
 * tick being stepped into, `cool` the ship's own cooldown. Returns the priming left.
 */
export function pilotJumpStep(
  body: { x: number; y: number; jump?: number }, primed: number, env: FieldEnv, tick: number, cool: number, t: JumpTuning,
  step: (rangeBoost: number) => void,
): number {
  step(fieldRangeBoost(inSolarRing(body.x, body.y, env.central, t), primed, t));
  const f = jumpFieldAt(body.x, body.y, env, tick, t);
  body.jump = fieldCooldown(body.jump ?? 0, cool, f, t, tick);
  return stepPrime(primed, body.jump, f, t);
}
