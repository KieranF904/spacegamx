/**
 * How the enemy AI leads its target (bodies/aiPilot.ts): by its main gun's real round, not one speed for every gun.
 * The server's commander works the lead out once from the ship's loadout (aiLoadout, with the guns' real reach and
 * whether one lobs) and puts it in the order as three whole numbers (leadPlaces); the pilot body, on the server and
 * on every client that flies it, reads them back (leadAt) and times the shell's flight (leadTicks). Deterministic:
 * whole numbers in the order, exact arithmetic and a square root (IEEE: the same everywhere).
 */

import type { ShipState } from '../ships/state.js';
import type { ShipTuning, WeaponTuning } from '../ships/tuning.js';
import { partWeaponDef, endsAtAim } from '../ships/launch.js';
import { baseWeaponDps } from '../ships/rating.js';

/** A round as the lead reads it: launch speed, acceleration a tick and top speed (u/tick) */
export interface AiLead { v: number; a: number; max: number }

/** The lead before rounds had their own (and still for an order without one): every shell at 45 a tick */
export const LEGACY_LEAD: Readonly<AiLead> = Object.freeze({ v: 45, a: 0, max: 45 });
/** The furthest a hostile opens fire with a beam, whatever the beam itself reaches (aiLoadout's usual beamReach) */
export const AI_BEAM_REACH = 1600;
/** A beam lands at once: led as a round this fast */
export const BEAM_LEAD_SPEED = 1000;
/** The most ticks of flight the AI leads by (beyond, a target's course is anyone's guess) */
export const LEAD_MAX_TICKS = 40;

/** Where an ENGAGE (and a HAUL) order's lead is (bodies/aiPilot.ts), and where an ENGAGE's mates start after it */
export const ORDER_LEAD = 8;
export const ENGAGE_MATES = 11;

/** The order's grids: speeds in quarters of a unit a tick, acceleration in 64ths */
const V_GRID = 4, A_GRID = 64;

/** The three order places for a lead */
export function leadPlaces(l: Readonly<AiLead>): [number, number, number] {
  return [Math.max(1, Math.round(l.v * V_GRID)), Math.max(0, Math.round(l.a * A_GRID)), Math.max(1, Math.round(l.max * V_GRID))];
}

/** The lead in an order from place `at` (no places there, or 0: LEGACY_LEAD) */
export function leadAt(w: readonly number[], at: number): AiLead {
  const v = w[at] ?? 0;
  if (v <= 0) return LEGACY_LEAD;
  const max = Math.max(v, w[at + 2] ?? v);
  return { v: v / V_GRID, a: (w[at + 1] ?? 0) / A_GRID, max: max / V_GRID };
}

/** Ticks a round takes to fly `d`: at its launch speed, gaining `a` a tick up to its top speed; at most LEAD_MAX_TICKS */
export function leadTicks(d: number, l: Readonly<AiLead>): number {
  const v = Math.max(1e-6, l.v);
  let t: number;
  if (l.a <= 0 || l.max <= v) t = d / v;
  else {
    const t1 = (l.max - v) / l.a, d1 = v * t1 + 0.5 * l.a * t1 * t1;
    t = d <= d1 ? (Math.sqrt(v * v + 2 * l.a * d) - v) / l.a : t1 + (d - d1) / l.max;
  }
  return Math.min(LEAD_MAX_TICKS, t);
}

/** A gun's round as the lead reads it (a homing or guided shell speeds up as server Weapons flies it; any other flies at its launch speed) */
export function roundLead(def: WeaponTuning): AiLead {
  if (def.type === 'beam') return { v: BEAM_LEAD_SPEED, a: 0, max: BEAM_LEAD_SPEED };
  const v = def.speed ?? 30;
  if (def.homing) return { v, a: def.accel ?? 0.5, max: Math.max(v, def.maxSpeed ?? 40) };
  if (def.guided) return { v, a: def.accel ?? 0, max: Math.max(v, def.maxSpeed ?? v) };
  return { v, a: 0, max: v };
}

/** What an AI ship's guns can do, as its commander learns it once: their real reach (the longest), whether one lobs, and its lead */
export interface AiLoadout { reach: number; lobs: boolean; lead: AiLead | undefined }

/**
 * An AI ship's loadout (`beamReach`: the furthest its beams open up from). Its lead is its main gun's round: the gun
 * that does the most damage a second (baseWeaponDps; ties to the first), point defence aside. No gun: no lead
 */
export function aiLoadout(tuning: ShipTuning, ship: ShipState, beamReach: number): AiLoadout {
  let reach = 0, lobs = false, best = -1, lead: AiLead | undefined;
  for (const w of ship.derived.weapons) {
    const def = partWeaponDef(tuning, w.kind, ship.blueprint.parts[w.part], { model: w.model });
    if (def.pointDefence) continue;
    // Beams: pilots' pulse lasers reach far, but hostiles only open up from nearer in (no sniping from past the edge of the screen)
    const r = def.type === 'beam' ? Math.min(def.range ?? 800, beamReach) : (def.maxSpeed ?? def.speed ?? 30) * (def.life ?? 60);
    if (endsAtAim(def)) lobs = true;
    reach = Math.max(reach, r);
    const dps = baseWeaponDps(tuning, w.kind, w.interval, def, w.fire);
    if (dps > best) { best = dps; lead = roundLead(def); }
  }
  return { reach, lobs, lead };
}
