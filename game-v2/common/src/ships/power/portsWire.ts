/**
 * @contract power.ports-wire
 * owns:       packing and reading the pilot row's ports slot, and the state digest
 * needs:      portsTypes, portsState
 * invariants: the slot layout is in the wire hash — common/src/network/wireDictionary.test.ts
 * extend:     a change to the slot is a protocol bump (PORTS_SLOT_LAYOUT)
 */

import { PF_MASK, P_SELECTOR, type PortsLayout, type PortsState } from './portsTypes.js';
import { fullPorts, portsGauge } from './portsState.js';

// ================================================================ the wire (the pilot row's energy slot, triples)
/** What the slot means (in the wire hash: a change of meaning is a protocol bump) */
export const PORTS_SLOT_LAYOUT = 'ports:quads(part,held*16+flags4,closed*2^24+mat*2^20+amt,aug);closed=a lit piece beam ticks left, a mining pulse ticks left';
export const PORTS_ROW = { sig: 8, count: 9, at: 13 } as const;
const FLAGS = 16, AMT_MOD = 1 << 20, MAT_MOD = 1 << 24, PER = 4;
/** Append the triples to `out` (from data[PORTS_ROW.at]). Returns the triple count; the row carries -count in data[PORTS_ROW.count] and L.sig in data[PORTS_ROW.sig] */
export function packPorts(L: PortsLayout, e: PortsState, out: number[]): number {
  let n = 0;
  for (let p = 0; p < L.n; p++) {
    const c = L.cap[p], full = e.held[p] === c && e.flags[p] === 0 && e.amt[p] === 0 && e.closed[p] === 0 && e.aug[p] === L.augCap[p];
    if ((c <= 0 && !L.matCap[p] && L.role[p] !== P_SELECTOR) || full) continue;
    out.push(p, e.held[p] * FLAGS + (e.flags[p] & PF_MASK), Math.min(32000, e.closed[p]) * MAT_MOD + e.mat[p] * AMT_MOD + Math.min(AMT_MOD - 1, e.amt[p]), e.aug[p]);
    n++;
  }
  return n;
}
/** Where a ports row's slot ends (data[9] is -count) */
export function portsSlotEnd(data: ArrayLike<number>): number {
  const n = Math.max(0, -(data[PORTS_ROW.count] | 0));
  return Math.min(data.length, PORTS_ROW.at + PER * n);
}
export const isPortsRow = (data: ArrayLike<number> | undefined): boolean => !!data && data.length > PORTS_ROW.count && (data[PORTS_ROW.count] | 0) < 0;
/** Read the slot into `e`: every part full and clear, then the triples. False (e untouched) when the sig isn't this layout's */
export function unpackPortsInto(L: PortsLayout, e: PortsState, data: ArrayLike<number>): boolean {
  if (!isPortsRow(data) || data[PORTS_ROW.sig] !== L.sig || e.held.length !== L.n) return false;
  fullPorts(L, e);
  const end = portsSlotEnd(data);
  for (let k = PORTS_ROW.at; k + PER - 1 < end; k += PER) {
    const p = data[k], v = data[k + 1], m = data[k + 2], g = data[k + 3];
    if (!Number.isInteger(p) || p < 0 || p >= L.n || !Number.isInteger(v) || v < 0 || !Number.isInteger(m) || m < 0) continue;
    const h = Math.floor(v / FLAGS);
    e.held[p] = h > L.cap[p] ? L.cap[p] : h; e.flags[p] = v - h * FLAGS;
    e.closed[p] = Math.floor(m / MAT_MOD); const rest = m - e.closed[p] * MAT_MOD; e.mat[p] = Math.floor(rest / AMT_MOD); e.amt[p] = rest - e.mat[p] * AMT_MOD;
    if (e.amt[p] > L.matCap[p]) e.amt[p] = L.matCap[p];
    e.aug[p] = Number.isInteger(g) && g > 0 ? Math.min(g, L.augCap[p]) : 0;
  }
  e.sig = L.sig; e.gauge = portsGauge(L, e);
  return true;
}
/** The 16-bit digest for the stateHash */
export function portsDigest(L: PortsLayout, e: PortsState): number {
  let h = 0x811c9dc5 | 0;
  for (let p = 0; p < L.n; p++) {
    if (L.cap[p] <= 0 && !L.matCap[p]) continue;
    h = Math.imul(h ^ p, 0x01000193); h = Math.imul(h ^ e.held[p], 0x01000193); h = Math.imul(h ^ e.flags[p], 0x01000193); h = Math.imul(h ^ e.amt[p], 0x01000193); h = Math.imul(h ^ e.aug[p], 0x01000193);
  }
  return ((h >>> 16) ^ (h & 0xffff)) & 0xffff;
}

