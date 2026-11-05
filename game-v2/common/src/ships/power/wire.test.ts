/**
 * The energy slot (power/wire.ts; docs/design/energy-routing-impl.md §4.1-4.2): exact round trip, sparse (full parts
 * left out), a sig mismatch ignored, and the replicas' thruster tail.
 */

import { describe, it, expect } from 'vitest';
import { CHARGE_GROUPS_AT, PILOT_ROW } from '../energy.js';
import { createEnergyState } from './state.js';
import { energyTick } from './tick.js';
import { ENERGY_ROW, energyDigest, energySlotEnd, packEnergy, packThrusterTail, unpackEnergyInto, unpackThrusterTail } from './wire.js';
import { genFn, layoutOf, storeFn } from './testData.js';
import { FLAG_LATCH } from './state.js';
import type { PartSpec } from './testData.js';

const SPECS: PartSpec[] = [
  ['sq', 'core', 0, 0], ['sq', genFn('t_gen', 35), 1, 0], ['sq', storeFn('t_bat', 300, 150, 50), 2, 0], ['sq', 'cannon_pip', 3, 0, 'E'],
  ['rect2', 'cannon_twinlink', 0, 1, 'W'], ['sq', 'engine_ion_drive', 2, 1, 'S'], ['sq', 'engine_burst_strafer', 3, 1, 'E'], ['sq', 'hull', 4, 0],
];

/** A pilot row as SnapshotBuilder lays it out: 13 leading values, the slot, then a pilot extra */
function row(L: ReturnType<typeof layoutOf>, e: ReturnType<typeof createEnergyState>): number[] {
  const data = new Array<number>(ENERGY_ROW.at).fill(0);
  data[ENERGY_ROW.sig] = L.sig;
  data[ENERGY_ROW.count] = packEnergy(L, e, data);
  data.push(777);
  return data;
}

describe('energy slot', () => {
  it('sits where the pilot row\'s pool, group count and groups are today', () => {
    expect([ENERGY_ROW.sig, ENERGY_ROW.count, ENERGY_ROW.at]).toEqual([PILOT_ROW.pool, PILOT_ROW.groups, CHARGE_GROUPS_AT]);
  });

  it('leaves full parts out, and round-trips exactly', () => {
    const L = layoutOf(SPECS), e = createEnergyState(L);
    expect(row(L, e).length).toBe(ENERGY_ROW.at + 1);
    e.held[2] = 12345; e.held[4] = 0; e.flags[4] = FLAG_LATCH; e.held[6] = 7;
    energyTick(L, e, { active: null, boosting: false, toolWant: null, reload: false });
    const data = row(L, e);
    const n = data[ENERGY_ROW.count];
    expect(n).toBeGreaterThanOrEqual(3);
    expect(energySlotEnd(data)).toBe(ENERGY_ROW.at + 2 * n);
    expect(data[energySlotEnd(data)]).toBe(777);
    const back = createEnergyState(L);
    expect(unpackEnergyInto(L, back, data)).toBe(true);
    expect(Array.from(back.held)).toEqual(Array.from(e.held));
    expect(Array.from(back.flags)).toEqual(Array.from(e.flags));
    expect(back.gauge).toBe(e.gauge);
  });

  it('is ignored when the row\'s layout sig isn\'t this one\'s (a rebuild race)', () => {
    const L = layoutOf(SPECS), e = createEnergyState(L);
    e.held[2] = 5;
    const data = row(L, e);
    data[ENERGY_ROW.sig] = L.sig ^ 1;
    const back = createEnergyState(L);
    back.held[2] = 99;
    expect(unpackEnergyInto(L, back, data)).toBe(false);
    expect(back.held[2]).toBe(99);
  });

  it('drops bad pairs (out of range, not a buffer, not whole, negative) and clamps a value past the cap', () => {
    const L = layoutOf(SPECS), e = createEnergyState(L);
    const data = new Array<number>(ENERGY_ROW.at).fill(0);
    data[ENERGY_ROW.sig] = L.sig;
    const pairs = [[-1, 8], [L.n + 5, 8], [1.5, 8], [7, 8], [2, -4], [2, NaN], [2, 2.5], [3, (L.cap[3] + 99) * 4 + 1], [2, 100 * 4]];
    data[ENERGY_ROW.count] = pairs.length;
    for (const [p, v] of pairs) data.push(p, v);
    expect(unpackEnergyInto(L, e, data)).toBe(true);
    const want = Array.from(L.cap);
    want[2] = 100; want[3] = L.cap[3];
    expect(Array.from(e.held)).toEqual(want);
    expect(e.flags[3]).toBe(1);
    // A count past the row's end reads only what is there
    const short = data.slice(0, ENERGY_ROW.at + 3);
    short[ENERGY_ROW.count] = 50;
    expect(energySlotEnd(short)).toBe(short.length);
    expect(unpackEnergyInto(L, e, short)).toBe(true);
  });

  it('digests held and flags into 16 bits: equal states agree, any change shows', () => {
    const L = layoutOf(SPECS), a = createEnergyState(L), b = createEnergyState(L);
    const d = energyDigest(L, a);
    expect(d).toBe(energyDigest(L, b));
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThan(65536);
    b.held[2]--;
    expect(energyDigest(L, b)).not.toBe(d);
    b.held[2]++; b.flags[4] = FLAG_LATCH;
    expect(energyDigest(L, b)).not.toBe(d);
  });

  it('carries replicas\' thrusters below their cap in a tail', () => {
    const L = layoutOf(SPECS), e = createEnergyState(L);
    e.held[6] = 1234;
    const out = [9];
    expect(packThrusterTail(L, e, out)).toBe(1);
    const back = createEnergyState(L);
    back.held[5] = 0;
    expect(unpackThrusterTail(L, back, out, 1)).toBe(out.length);
    expect([back.held[5], back.held[6]]).toEqual([L.cap[5], 1234]);
  });
});
