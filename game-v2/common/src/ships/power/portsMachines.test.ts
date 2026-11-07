/**
 * Field machines on the ports core (docs/design/field-fabrication.md): a fabricator or refiner is a tool that draws its
 * rate only while PortsState.mach has its bit, and nothing otherwise; what it got is summed into machEu (its jobs'
 * clock). The switches and counters survive a remap. Ships without one are unchanged.
 */

import { describe, it, expect } from 'vitest';
import type { Blueprint, PlacedPart, Rot } from '../types.js';
import { createShipState } from '../state.js';
import { stepShipPhysics } from '../physics.js';
import { fullPortsCharge, remapCharge, type Charge } from '../energy.js';
import type { FlightBody, FlightControls } from '../flight.js';
import { readShipJson, testCatalog } from '../testData.js';
import type { ShipTuning } from '../tuning.js';
import { MACHINE_FAB, MACHINE_REF, P_TOOL, portsGauge, portsMachineEu, portsMachinePart, remapPortsByIndex, setPortsMachine } from './ports.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const p = (uid: number, piece: string, fn: string, x: number, y: number, rot = 0): PlacedPart =>
  ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: rot as Rot, flip: false });

/** A 2x1 core; a Field Fabricator under it fed by two Cell Reactors under that; a Field Refiner beside the core fed by one */
function design(): Blueprint {
  return {
    name: 'machines', catalogVersion: 1, power: 'ports',
    parts: [
      p(0, 'rect2', 'core', 0, 0),
      p(1, 'rect2', 'fabricator_field', 0, 1), p(2, 'sq', 'power_cell_reactor', 0, 2), p(3, 'sq', 'power_cell_reactor', 1, 2),
      p(4, 'sq', 'refiner_field', 2, 0), p(5, 'sq', 'power_cell_reactor', 2, 1),
    ],
  };
}
const NONE: FlightControls = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: -Math.PI / 2 };
const body = (): FlightBody => ({ x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0 });
function fly(d: ReturnType<typeof createShipState>['derived'], c: Charge, ticks: number): Charge {
  const b = body();
  for (let t = 0; t < ticks; t++) c = stepShipPhysics(b, NONE, d, tuning, { charge: c, drainRate: 1, tick: t }, null).charge;
  return c;
}

describe('field machines on the ports core', () => {
  const d = createShipState(catalog, tuning, 1, design(), 0).derived;
  const L = d.ports!;

  it('are tools of their kind, and the layout totals their draw', () => {
    const fab = portsMachinePart(L, MACHINE_FAB), ref = portsMachinePart(L, MACHINE_REF);
    expect(fab).toBe(1);
    expect(ref).toBe(4);
    expect(L.role[fab]).toBe(P_TOOL);
    expect(L.machineDraw).toBeCloseTo(40 + 20);
    expect(d.fx?.machines).toEqual({ fab: 1, fabTier: 1, ref: 4, refTier: 1 });
  });

  it('draw nothing while off, their rate while on, and count what they took', () => {
    let c = fullPortsCharge(d);
    c = fly(d, c, 120);
    expect(portsMachineEu(c.e!, MACHINE_FAB)).toBe(0);
    expect(portsMachineEu(c.e!, MACHINE_REF)).toBe(0);
    setPortsMachine(c.e!, MACHINE_FAB, true);
    c = fly(d, c, 600);
    const fab = portsMachinePart(L, MACHINE_FAB);
    // (Fed well: it takes its whole rate each tick)
    expect(portsMachineEu(c.e!, MACHINE_FAB)).toBe(600 * L.rate[fab]);
    expect(c.e!.sat[fab]).toBe(255);
    expect(portsMachineEu(c.e!, MACHINE_REF)).toBe(0);
    setPortsMachine(c.e!, MACHINE_FAB, false);
    const at = portsMachineEu(c.e!, MACHINE_FAB);
    c = fly(d, c, 60);
    expect(portsMachineEu(c.e!, MACHINE_FAB)).toBe(at);
  });

  it('keep their switches and counters through a rebuild into another design', () => {
    let c = fullPortsCharge(d);
    setPortsMachine(c.e!, MACHINE_REF, true);
    c = fly(d, c, 30);
    const eu = portsMachineEu(c.e!, MACHINE_REF);
    expect(eu).toBeGreaterThan(0);
    const bigger = design();
    bigger.parts.push(p(6, 'sq', 'hull', -1, 0));
    const d2 = createShipState(catalog, tuning, 1, bigger, 0).derived;
    const c2 = remapCharge(d, d2, c);
    expect(c2.e!.held.length).toBe(d2.ports!.n);
    expect(c2.e!.mach).toBe(c.e!.mach);
    expect(portsMachineEu(c2.e!, MACHINE_REF)).toBe(eu);
  });

  it('carry over by part index into a design with parts added or taken away: never a free refill (a plan save)', () => {
    let c = fullPortsCharge(d);
    setPortsMachine(c.e!, MACHINE_FAB, true);
    c = fly(d, c, 300);
    const e = c.e!;
    const eu = portsMachineEu(e, MACHINE_FAB);
    // (Drain the stores to something known, below full)
    for (let i = 0; i < L.n; i++) e.held[i] = Math.floor(L.cap[i] / 3);
    // A part appended (a planned part): the old ones keep what they held, the new one starts empty
    const bigger = design();
    bigger.parts.push(p(6, 'sq', 'power_cell_reactor', 3, 0));
    const L2 = createShipState(catalog, tuning, 1, bigger, 0).derived.ports!;
    const keep = bigger.parts.map((_, i) => (i < design().parts.length ? i : -1));
    const e2 = remapPortsByIndex(e, L2, keep);
    expect(e2.held.length).toBe(L2.n);
    for (let i = 0; i < L.n; i++) expect(e2.held[i]).toBe(Math.min(L2.cap[i], e.held[i]));
    expect(e2.held[6]).toBe(0);
    expect(e2.mach).toBe(e.mach);
    expect(portsMachineEu(e2, MACHINE_FAB)).toBe(eu);
    expect(e2.gauge).toBe(portsGauge(L2, e2));
    // A part taken away (recycled): the rest move down by index and keep theirs
    const smaller = design();
    smaller.parts.splice(5, 1);
    const L3 = createShipState(catalog, tuning, 1, smaller, 0).derived.ports!;
    const e3 = remapPortsByIndex(e, L3, [0, 1, 2, 3, 4]);
    for (let i = 0; i < 5; i++) expect(e3.held[i]).toBe(Math.min(L3.cap[i], e.held[i]));
    const total = (s: { held: Int32Array }) => s.held.reduce((a, b) => a + b, 0);
    expect(total(e3)).toBeLessThanOrEqual(total(e));
  });
});
