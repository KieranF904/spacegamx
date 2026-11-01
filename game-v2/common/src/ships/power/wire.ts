/**
 * The energy slot of the pilot's own row (docs/design/energy-routing-impl.md §4.1): sparse and exact.
 *
 * - data[ENERGY_ROW.sig] the layout's sig: a client whose layout differs (a rebuild race) ignores the slot;
 * - data[ENERGY_ROW.count] n, then from data[ENERGY_ROW.at] n pairs (part, held × 4 + flags), in part order. A part
 *   that holds something is left out when it is full and unflagged, and is then taken as full.
 * The slots are PILOT_ROW.pool / .groups and CHARGE_GROUPS_AT today (energy.ts; renamed sig / energyCount in P2).
 * The pilot extras and gun state follow at energySlotEnd(data).
 *
 * Replicas' keyframe tail (P3, §4.2): a count, then (thruster ordinal, held) for thrusters below their cap.
 */

import { type EnergyLayout, PHASE_THRUST } from './layout.js';
import { type EnergyState, energyGauge } from './state.js';

/** What the slot means (the wire hash: a change of meaning is a protocol bump) */
export const ENERGY_SLOT_LAYOUT = 'part-sparse-eu256-flags2';
/** Where the slot sits in the pilot row */
export const ENERGY_ROW = { sig: 8, count: 9, at: 13 } as const;

/** A pair's value: held × 4 + flags (two flag bits) */
const FLAG_SCALE = 4;

/**
 * Append the slot's pairs to `out` (the row from data[ENERGY_ROW.at]). Returns the pair count: the caller puts it in
 * data[ENERGY_ROW.count], and L.sig in data[ENERGY_ROW.sig]
 */
export function packEnergy(L: EnergyLayout, e: EnergyState, out: number[]): number {
  let n = 0;
  for (let p = 0; p < L.n; p++) {
    const c = L.cap[p];
    if (c <= 0 || (e.held[p] === c && e.flags[p] === 0)) continue;
    out.push(p, e.held[p] * FLAG_SCALE + (e.flags[p] & 3));
    n++;
  }
  return n;
}

/**
 * The 16-bit energy digest folded into the once-a-second stateHash (§4.1b): FNV-1a over (part, held, flags) of every
 * part that holds something, in part order. Server and pilot compute it here alike; a mismatch forces a snapshot
 */
export function energyDigest(L: EnergyLayout, e: EnergyState): number {
  let h = 0x811c9dc5 | 0;
  for (let p = 0; p < L.n; p++) {
    if (L.cap[p] <= 0) continue;
    h = Math.imul(h ^ p, 0x01000193);
    h = Math.imul(h ^ e.held[p], 0x01000193);
    h = Math.imul(h ^ e.flags[p], 0x01000193);
  }
  return ((h >>> 16) ^ (h & 0xffff)) & 0xffff;
}

/** Where the slot ends (the pilot extras start there) */
export function energySlotEnd(data: ArrayLike<number>): number {
  const n = Math.max(0, data[ENERGY_ROW.count] | 0);
  return Math.min(data.length, ENERGY_ROW.at + 2 * n);
}

/**
 * Read the slot into `e`: every buffered part full and unflagged, then the pairs. False (and `e` untouched) when the
 * row's sig isn't this layout's or the row is too short. Out-of-range parts and values are dropped or clamped
 */
export function unpackEnergyInto(L: EnergyLayout, e: EnergyState, data: ArrayLike<number>): boolean {
  if (data.length <= ENERGY_ROW.count || data[ENERGY_ROW.sig] !== L.sig || e.held.length !== L.n) return false;
  const end = energySlotEnd(data);
  e.held.set(L.cap);
  e.flags.fill(0);
  for (let k = ENERGY_ROW.at; k + 1 < end; k += 2) {
    const p = data[k], v = data[k + 1];
    if (!Number.isInteger(p) || p < 0 || p >= L.n || L.cap[p] <= 0 || !Number.isInteger(v) || v < 0) continue;
    const h = Math.floor(v / FLAG_SCALE);
    e.held[p] = h > L.cap[p] ? L.cap[p] : h;
    e.flags[p] = v - h * FLAG_SCALE;
  }
  e.sig = L.sig;
  e.gauge = energyGauge(L, e);
  return true;
}

/** Append the thruster tail (count, then (ordinal, held) for thrusters below their cap) to `out`. Returns the count */
export function packThrusterTail(L: EnergyLayout, e: EnergyState, out: number[]): number {
  const at = out.length;
  out.push(0);
  let n = 0;
  for (let x = L.phase[PHASE_THRUST], o = 0; x < L.phase[PHASE_THRUST + 1]; x++, o++) {
    const p = L.cons[x];
    if (e.held[p] >= L.cap[p]) continue;
    out.push(o, e.held[p]);
    n++;
  }
  out[at] = n;
  return n;
}

/** Read a thruster tail at data[at] into `e` (thrusters not listed are full). Returns the index after it */
export function unpackThrusterTail(L: EnergyLayout, e: EnergyState, data: ArrayLike<number>, at: number): number {
  const t0 = L.phase[PHASE_THRUST], nT = L.phase[PHASE_THRUST + 1] - t0;
  for (let x = 0; x < nT; x++) e.held[L.cons[t0 + x]] = L.cap[L.cons[t0 + x]];
  const n = Math.max(0, Math.min(data[at] | 0, Math.floor((data.length - at - 1) / 2)));
  for (let k = 0; k < n; k++) {
    const o = data[at + 1 + 2 * k], h = data[at + 2 + 2 * k];
    if (!Number.isInteger(o) || o < 0 || o >= nT || !Number.isFinite(h)) continue;
    const p = L.cons[t0 + o];
    e.held[p] = Math.max(0, Math.min(L.cap[p], Math.floor(h)));
  }
  return at + 1 + 2 * n;
}
