/**
 * The tools the pool used to cover, on the ports core: a Tow Beam draws only while TOW_BIT is on, and its fulfilment is
 * its pull's share; a Flash Screen is a store with no draw that fills over its in port and is spent whole (flashPay); a
 * hazard that saps the stores (radiation, HazardFlight.cap) holds each store under its share.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../blueprint.js';
import { createShipState } from '../state.js';
import { stepShipPhysics } from '../physics.js';
import { fullPortsCharge, type Charge } from '../energy.js';
import type { FlightBody, FlightControls } from '../flight.js';
import { feedParts, readShipJson, testCatalog, SHIP_DATA_DIR } from '../testData.js';
import type { ShipTuning } from '../tuning.js';
import type { ShipDerived } from '../rebuild.js';
import { P_TOOL, TOW_BIT, portsCapStores, setPortsTow } from './ports.js';
import { canTow, towShare } from '../features/tow/tow.js';
import { flashPay } from '../features/flash/flash.js';
import { toEu } from './units.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const TOW = { uid: 70, piece: 'rect2', fn: 'utility_tow_beam', material: 'steel', x: -3, y: 0, rot: 0, flip: false, facing: 'W' };
const FLASH = { uid: 71, piece: 'sq', fn: 'shield_flash_screen', material: 'steel', x: -2, y: 0, rot: 0, flip: false };
/** The starter with parts added, fed (a Cell Reactor across each in port) or not */
const ship = (extra: object[], fed = true): ShipDerived => {
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
  bp.parts.push(...(extra as never[]));
  if (fed) feedParts(catalog, bp, (extra as { uid: number }[]).map((q) => q.uid));
  return createShipState(catalog, tuning, 1, bp, 0).derived;
};
const NONE: FlightControls = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: -Math.PI / 2 };
const FWD: FlightControls = { ...NONE, forward: true, boost: true };
function fly(d: ShipDerived, c: Charge, ticks: number, input = NONE, hazard?: { control: number; driftAccel: number; jump: number; cap: number }): Charge {
  const b: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0 };
  for (let t = 0; t < ticks; t++) c = stepShipPhysics(b, input, d, tuning, { charge: c, drainRate: 1, tick: t }, null, 1, hazard).charge;
  return c;
}

describe('Tow Beam on the ports core', () => {
  it('can tow only once power reaches it', () => {
    expect(canTow(ship([TOW]))).toBe(true);
    expect(canTow(ship([TOW], false))).toBe(false);
    expect(canTow(ship([]))).toBe(false);
  });

  it('draws nothing while switched off, its rate while on, and its share is what it got', () => {
    const d = ship([TOW]), p = d.fx!.tow!.parts[0], L = d.ports;
    expect(L.role[p]).toBe(P_TOOL);
    expect(L.tow[p]).toBe(1);
    let c = fullPortsCharge(d);
    c = fly(d, c, 120);
    expect(c.e!.held[p]).toBe(L.cap[p]);
    setPortsTow(c.e!, true);
    expect(c.e!.mach & TOW_BIT).toBe(TOW_BIT);
    c = fly(d, c, 300);
    // (Fed: its lines refill what it draws each tick)
    expect(c.e!.sat[p]).toBe(255);
    expect(towShare(d, c)).toBe(1);
    setPortsTow(c.e!, false);
    expect(c.e!.mach & TOW_BIT).toBe(0);
  });

  it('cut off, runs its one-second buffer dry and its share falls to nothing', () => {
    const d = ship([TOW], false), p = d.fx!.tow!.parts[0];
    let c = fullPortsCharge(d);
    setPortsTow(c.e!, true);
    c = fly(d, c, 30);
    expect(towShare(d, c)).toBe(1);
    c = fly(d, c, 60);
    expect(c.e!.sat[p]).toBe(0);
    expect(towShare(d, c)).toBe(0);
  });

  it('is unaccounted (share 1) for a ship with no ports state yet', () => {
    expect(towShare(ship([TOW]), {})).toBe(1);
  });
});

describe('Flash Screen store on the ports core', () => {
  it('is a store of flashCost E a point with no draw of its own', () => {
    const d = ship([FLASH]), p = d.fx!.flash!.parts[0], L = d.ports;
    expect(L.flash[p]).toBe(1);
    const fn = catalog.functions.get('shield_flash_screen')!;
    expect(fn.flashCost).toBeGreaterThan(0);
    // (36 points at 4 E: 144 E, in eu)
    expect(L.cap[p]).toBe(toEu(fn.flashCost! * d.fx!.flash!.pts[0]));
    expect(d.fx!.flash!.pts).toEqual([d.fx!.flash!.max]);
    // Full, it stays full and takes nothing
    let c = fullPortsCharge(d);
    c = fly(d, c, 120);
    expect(c.e!.held[p]).toBe(L.cap[p]);
  });

  it('pays whole when full, never when short, and refills over its in port', () => {
    const d = ship([FLASH]), p = d.fx!.flash!.parts[0], L = d.ports;
    let c = fullPortsCharge(d);
    expect(flashPay(L, c.e!, p)).toBe(true);
    expect(c.e!.held[p]).toBe(0);
    expect(flashPay(L, c.e!, p)).toBe(false);
    c = fly(d, c, 60);
    const after1s = c.e!.held[p];
    expect(after1s).toBeGreaterThan(0);
    expect(after1s).toBeLessThan(L.cap[p]);
    expect(flashPay(L, c.e!, p)).toBe(false);
    expect(c.e!.held[p]).toBe(after1s);
    c = fly(d, c, 900);
    expect(c.e!.held[p]).toBe(L.cap[p]);
    expect(flashPay(L, c.e!, p)).toBe(true);
  });

  it('cut off, never refills', () => {
    const d = ship([FLASH], false), p = d.fx!.flash!.parts[0];
    let c = fullPortsCharge(d);
    expect(flashPay(d.ports, c.e!, p)).toBe(true);
    c = fly(d, c, 600);
    expect(c.e!.held[p]).toBe(0);
  });

  it('is not a steady load', () => {
    expect(ship([FLASH]).energy.demand).toBe(ship([]).energy.demand);
  });
});

describe('a hazard that saps the stores (radiation: HazardFlight.cap)', () => {
  const d = ship([]), L = d.ports;
  const stores = [...L.relays].filter((r) => !L.carrier[r]);
  const RAD = { control: 1, driftAccel: 0, jump: 1, cap: 0.84 };

  it('holds every store under its share of its capacity, flying or not', () => {
    expect(stores.length).toBeGreaterThan(0);
    let c = fly(d, fullPortsCharge(d), 120, NONE, RAD);
    for (const r of stores) expect(c.e!.held[r]).toBeLessThanOrEqual(Math.floor(L.cap[r] * 0.84));
    c = fly(d, c, 120, FWD, RAD);
    for (const r of stores) expect(c.e!.held[r]).toBeLessThanOrEqual(Math.floor(L.cap[r] * 0.84));
  });

  it('leaves the stores alone with no hazard, and a share of 1 changes nothing', () => {
    const a = fly(d, fullPortsCharge(d), 200, FWD), b = fly(d, fullPortsCharge(d), 200, FWD, { ...RAD, cap: 1 });
    expect(Array.from(b.e!.held)).toEqual(Array.from(a.e!.held));
    const full = fly(d, fullPortsCharge(d), 60);
    expect(stores.some((r) => full.e!.held[r] > Math.floor(L.cap[r] * 0.84))).toBe(true);
  });

  it('caps in whole eu, the same every run, and keeps the gauge true', () => {
    const e = fullPortsCharge(d).e!;
    portsCapStores(L, e, 0.5);
    for (const r of stores) expect(e.held[r]).toBe(Math.floor(L.cap[r] * 0.5));
    let g = 0; for (const r of L.relays) g += e.held[r];
    expect(e.gauge).toBe(g);
    const again = fullPortsCharge(d).e!;
    portsCapStores(L, again, 0.5);
    expect(Array.from(again.held)).toEqual(Array.from(e.held));
  });
});
