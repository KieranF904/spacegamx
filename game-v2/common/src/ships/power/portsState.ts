/**
 * @contract power.ports-state
 * owns:       PortsState creation and remaps, gauges, tool switches (field machines, Tow Beams), a hazard's cap on the
 *             stores and a part's effective stats under its material
 * needs:      portsTypes
 * invariants: remaps keep what a kept part held — common/src/ships/power/ports.test.ts
 *             Tow Beams draw only while switched on; a capped store holds no more than its share —
 *             common/src/ships/power/portsTools.test.ts
 * extend:     a new material-shaped stat is an eff* beside effShot
 */

import { MACHINE_FAB, machineBit, MACHINE_REF, P_SELECTOR, TOW_BIT, type PortsLayout, type PortsState } from './portsTypes.js';
import { portsRapidShot } from './portsMods.js';

// ================================================================ state
export function createPortsState(L: PortsLayout): PortsState {
  return fullPorts(L, { sig: L.sig, held: new Int32Array(L.n), flags: new Uint8Array(L.n), amt: new Int32Array(L.n), mat: new Uint8Array(L.n), closed: new Int16Array(L.n), aug: new Int32Array(L.n), sat: new Uint8Array(L.n), shieldSat: 255, gauge: 0, mach: 0, machEu: new Float64Array(3) });
}
/** Everything full: stores, buffers and tanks; no material in the guns, lines or engines */
export function fullPorts(L: PortsLayout, out?: PortsState): PortsState {
  if (!out || out.held.length !== L.n) return createPortsState(L);
  out.held.set(L.cap); out.aug.set(L.augCap);
  for (const c of L.carriers) out.held[c] = 0;
  out.flags.fill(0); out.amt.fill(0); out.mat.fill(0); out.closed.fill(0); out.sat.fill(255); out.shieldSat = 255; out.sig = L.sig; out.gauge = portsGauge(L, out);
  return out;
}
/** After a rebuild: the same design keeps what each part held (clamped); a new one starts full */
export function remapPorts(e: PortsState, after: PortsLayout, sameDesign: boolean): PortsState {
  if (!sameDesign || e.held.length !== after.n) {
    // (The field machines' switches and their energy counters go with the ship, whatever its design: jobs progress by them)
    const f = fullPorts(after, e.held.length === after.n ? e : undefined);
    if (f !== e) { f.mach = e.mach; f.machEu.set(e.machEu); }
    return f;
  }
  for (let i = 0; i < after.n; i++) {
    if (e.held[i] > after.cap[i]) e.held[i] = after.cap[i];
    if (e.held[i] < 0) e.held[i] = 0;
    if (e.aug[i] > after.augCap[i]) e.aug[i] = after.augCap[i];
    if (e.amt[i] > after.matCap[i]) e.amt[i] = after.matCap[i];
    if (e.amt[i] <= 0) { e.amt[i] = 0; e.mat[i] = 0; }
    if (after.gun[i] === 0 && after.role[i] !== P_SELECTOR) e.flags[i] = 0;
  }
  e.sig = after.sig; e.gauge = portsGauge(after, e);
  return e;
}
/**
 * Into another design whose parts are the old one's moved about, some added (a field plan's appended parts) or taken
 * away (a recycled part): `keep[i]` is the old index of the new part i, or -1 for a new part. A kept part keeps what it
 * held (clamped, as remapPorts does); a new one starts empty. So a plan save or a recycle is never a free store refill
 * (docs/design/field-fabrication.md section 5.1). The machines' switches and counters go with the ship
 */
export function remapPortsByIndex(e: PortsState, after: PortsLayout, keep: ArrayLike<number>): PortsState {
  const out = createPortsState(after);
  const old = e.held.length;
  out.held.fill(0); out.aug.fill(0);
  for (let i = 0; i < after.n; i++) {
    const o = i < keep.length ? keep[i] : -1;
    if (!(o >= 0 && o < old)) continue;
    out.held[i] = Math.max(0, Math.min(after.cap[i], e.held[o]));
    out.aug[i] = Math.max(0, Math.min(after.augCap[i], e.aug[o]));
    out.amt[i] = Math.max(0, Math.min(after.matCap[i], e.amt[o]));
    out.mat[i] = out.amt[i] > 0 ? e.mat[o] : 0;
    out.closed[i] = e.closed[o];
    out.sat[i] = e.sat[o];
    out.flags[i] = after.gun[i] === 0 && after.role[i] !== P_SELECTOR ? 0 : e.flags[o];
  }
  out.shieldSat = e.shieldSat;
  out.mach = e.mach;
  out.machEu.set(e.machEu);
  out.sig = after.sig; out.gauge = portsGauge(after, out);
  return out;
}
export function portsGauge(L: PortsLayout, e: PortsState): number { let g = 0; for (const r of L.relays) g += e.held[r]; return g; }
export function portsGaugePct(L: PortsLayout, e: PortsState): number { return L.gaugeMax > 0 ? Math.round((10000 * e.gauge) / L.gaugeMax) / 100 : 100; }
/** The live part that is this kind of field machine (MACHINE_FAB, MACHINE_REF), or -1 */
export function portsMachinePart(L: PortsLayout, kind: number): number {
  for (const p of L.tools) if (L.machine[p] === kind) return p;
  return -1;
}
/** Let a field machine draw (on) or not: the server's decision, applied on the tick it is made on both sides */
export function setPortsMachine(e: PortsState, kind: number, on: boolean): void {
  const b = machineBit(kind);
  e.mach = on ? e.mach | b : e.mach & ~b;
}
/** eu a field machine kind has taken in all (its jobs progress by the difference between two reads) */
export function portsMachineEu(e: PortsState, kind: number): number { return e.machEu[kind] ?? 0; }
/** Let the Tow Beams draw (on: the ship tows) or not: the server's decision, as a machine's (TOW_BIT) */
export function setPortsTow(e: PortsState, on: boolean): void {
  e.mach = on ? e.mach | TOW_BIT : e.mach & ~TOW_BIT;
}
/**
 * A hazard that saps the stores (radiation: hazards.ts HazardFlight.cap): each store (the core and the banks; not the
 * lines) holds at most `share` of its capacity, what's over is lost. Integer eu, the same on every side
 */
export function portsCapStores(L: PortsLayout, e: PortsState, share: number): void {
  if (!(share < 1) || e.held.length !== L.n) return;
  const f = share > 0 ? Math.round(share * 1000) / 1000 : 0;
  let any = false;
  for (const r of L.relays) {
    if (L.carrier[r]) continue;
    const m = Math.floor(L.cap[r] * f);
    if (e.held[r] > m) { e.held[r] = m; any = true; }
  }
  if (any) e.gauge = portsGauge(L, e);
}

// ================================================================ effective stats (a part's material)
/** The feed index a part's stats are shaped by now: its material, if it holds enough for its next use and takes it */
export function matOf(L: PortsLayout, e: PortsState, p: number): number {
  const f = e.mat[p];
  if (!f || e.amt[p] < L.matUse[p] || !(L.takes[p] & (1 << (f - 1)))) return 0;
  return f;
}
export const W = (L: PortsLayout) => L.feeds.length;
/** (A gun with Rapid live pays less a shot: power/portsMods.ts) */
export const effShot = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p), s = f ? Math.round(L.shot[p] * L.mShot[p * W(L) + f]) : L.shot[p]; return L.mod ? portsRapidShot(L, e, p, s) : s; };
export const effDamage = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f ? L.mDamage[p * W(L) + f] : 1; };
export const effCycle = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f ? L.mCycle[p * W(L) + f] : 1; };
export const effDischarge = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f ? Math.round(L.discharge[p] * L.mDischarge[p * W(L) + f]) : L.discharge[p]; };
export const effRest = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f ? Math.round(L.rest[p] * L.mRest[p * W(L) + f]) : L.rest[p]; };
export const effSteady = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f ? Math.round(L.steady[p] * L.mSteady[p * W(L) + f]) : L.steady[p]; };
/** A gun's buffer under its material (a bigger shot: a bigger buffer) */
export const effCap = (L: PortsLayout, e: PortsState, p: number): number => { const f = matOf(L, e, p); return f && L.gun[p] ? (L.gun[p] === 3 ? L.cap[p] : Math.round(L.cap[p] * L.mShot[p * W(L) + f])) : L.cap[p]; };
/** Thrust multiplier (material, and boost when boosting) */
export function effThrust(L: PortsLayout, e: PortsState, p: number): number { const f = matOf(L, e, p); return f ? L.mThrust[p * W(L) + f] : 1; }
