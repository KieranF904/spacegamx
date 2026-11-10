// Local copy of the retired relay-style energy state (was common/src/ships/power/state.ts, removed from the shared core:
// the game runs the ports core). Only shipgen's check/partPower still read this model (its layout: energyLayout.ts);
// retargeting them at the ports core is a separate job.

/**
 * A ship's energy, per part, in eu (docs/design/energy-routing-impl.md §2.3): what every relay, weapon and thruster
 * holds, and its flags. Allocated once per layout (createEnergyState), never per tick.
 */

import { type EnergyLayout, GUN_BEAM, GUN_CLIP } from './energyLayout';

/** A clip reloading (it takes energy, and can't fire, until the whole clip is paid), or a beam resting */
export const FLAG_LATCH = 1;
/** A beam lit (burning while the trigger's held and it has a tick's burn) */
export const FLAG_LIT = 2;

export interface EnergyState {
  /** The layout's sig this state is laid out for */
  sig: number;
  /** eu held, per part (0 for parts that hold nothing) */
  held: Int32Array;
  /** FLAG_LATCH | FLAG_LIT, per part */
  flags: Uint8Array;
  /** Tools: the share of what each wanted that it got this tick, 0..255 (255 when it wanted nothing) */
  sat: Uint8Array;
  /** Shields together: the share of what they wanted that they got this tick, 0..255 */
  shieldSat: number;
  /** eu in every relay together (the gauge) */
  gauge: number;
}

/** A new state for the layout, everything full (spawn, respawn, a refit) */
export function createEnergyState(L: EnergyLayout): EnergyState {
  return fullEnergy(L, { sig: L.sig, held: new Int32Array(L.n), flags: new Uint8Array(L.n), sat: new Uint8Array(L.n), shieldSat: 255, gauge: 0 });
}

/** Everything full and unlatched: into `out` when it fits the layout, else a new state */
export function fullEnergy(L: EnergyLayout, out?: EnergyState): EnergyState {
  if (!out || out.held.length !== L.n) return createEnergyState(L);
  out.held.set(L.cap);
  out.flags.fill(0);
  out.sat.fill(255);
  out.shieldSat = 255;
  out.sig = L.sig;
  out.gauge = L.gaugeMax;
  return out;
}

/**
 * The state after a rebuild. `sameDesign` (the same blueprint: damage, a repair, parts lost): each part keeps what it
 * held, clamped to its new cap, so a destroyed part is empty and a repaired one starts empty (a clip of it latches on its
 * first tick). A refit (a new blueprint): full. In place when the part count is unchanged
 */
export function remapEnergy(e: EnergyState, after: EnergyLayout, sameDesign: boolean): EnergyState {
  if (!sameDesign || e.held.length !== after.n) return fullEnergy(after, e.held.length === after.n ? e : undefined);
  for (let i = 0; i < after.n; i++) {
    const c = after.cap[i];
    if (e.held[i] > c) e.held[i] = c;
    if (e.held[i] < 0) e.held[i] = 0;
    // (only clips and beams carry flags)
    if (c === 0 || (after.gun[i] !== GUN_CLIP && after.gun[i] !== GUN_BEAM)) e.flags[i] = 0;
    else if (after.gun[i] === GUN_CLIP) e.flags[i] &= FLAG_LATCH;
  }
  e.sig = after.sig;
  e.gauge = energyGauge(after, e);
  return e;
}

/** eu in every relay together */
export function energyGauge(L: EnergyLayout, e: EnergyState): number {
  let g = 0;
  const R = L.relays;
  for (let k = 0; k < R.length; k++) g += e.held[R[k]];
  return g;
}

/** The gauge as a percentage (hundredths), as the pilot row's data[1] carries it: 100 with no stores */
export function energyGaugePct(L: EnergyLayout, e: EnergyState): number {
  return L.gaugeMax > 0 ? Math.round((10000 * e.gauge) / L.gaugeMax) / 100 : 100;
}

