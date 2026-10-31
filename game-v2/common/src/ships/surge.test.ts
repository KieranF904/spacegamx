/**
 * Surge (energy Phase 2): Pulse Dynamos join the capacitor bank they touch and charge it with no wires; parts fed Surge
 * by touch react by category (charged shots, kicks, flash restores); the dual-fed Rail Driver and Flash Screen.
 */

import { describe, it, expect } from 'vitest';
import type { Blueprint, PlacedPart, Rot } from './types.js';
import { validateBlueprint } from './blueprint.js';
import { createShipState } from './state.js';
import type { ShipTuning } from './tuning.js';
import { stepGuns } from './guns.js';
import { stepFlight } from './flight.js';
import { FULL_CHARGE, gunLoad, powerTick, type Charge } from './energy.js';
import { bankFor, flashRestore, surgeReaction, surgeTuning } from './surge.js';
import { readShipJson, testCatalog } from './testData.js';
import { FRICTION, BOOST_FACTOR, WORLD_SIZE } from '../constants.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const st = surgeTuning(tuning);
const p = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });
const codes = (b: Blueprint) => validateBlueprint(catalog, b, tuning, null).errors.map((e) => e.code);
const pose = { x: 0, y: 0, angle: -Math.PI / 2 };

//   y=0:  Pip(-1)  CORE(0,1)  Pip(2)  [3,0]
//   y=1:  R(-1)    h(0) h(1)  h(2)    [3,1]
//   y=2:  [-1,2]   E(0) E(1)  [2,2]
const base = (extra: PlacedPart[] = []): Blueprint => ({
  name: 'test', catalogVersion: 1,
  parts: [
    p(0, 'rect2', 'core', 0, 0), p(1, 'sq', 'cannon_pip', -1, 0, { facing: 'N' }), p(2, 'sq', 'cannon_pip', 2, 0, { facing: 'N' }),
    p(3, 'sq', 'power_cell_reactor', -1, 1), p(4, 'sq', 'hull', 0, 1), p(5, 'sq', 'hull', 1, 1), p(6, 'sq', 'hull', 2, 1),
    p(7, 'sq', 'engine_ion_drive', 0, 2, { facing: 'S' }), p(8, 'sq', 'engine_ion_drive', 1, 2, { facing: 'S' }),
    ...extra,
  ],
});

/** Shots (with their damage ×) the right Pip fires in `ticks`, holding the trigger from charge `c` */
function fire(b: Blueprint, ticks: number, c0: Charge = FULL_CHARGE, release = 0) {
  const ship = createShipState(catalog, tuning, 1, b, 0);
  let c = c0;
  const out: { t: number; part: number; damage: number }[] = [];
  for (let t = 1; t <= ticks; t++) {
    c = powerTick(ship.derived, c, { thrusting: false, boosting: false, load: gunLoad(ship, t) }, tuning).charge;
    const energy = { charge: c };
    const firing = !(release && t % release > release / 2);
    for (const s of stepGuns(ship, pose, { firing, aimWorld: -Math.PI / 2, aimDist: 0, energy }, t, tuning).shots) out.push({ t, part: s.w.part, damage: s.shot.damageScale });
    c = energy.charge;
  }
  return { out, charge: c, ship };
}

describe('Surge: banks and the Pulse Dynamo', () => {
  it('a Pulse Dynamo is part of the bank it touches, joins no wire network, and charges the bank with no wires', () => {
    // Two capacitors against the right Pip, a Dynamo against them; nothing wired to them
    const b = { ...base([p(9, 'sq', 'power_capacitor', 3, 0), p(10, 'sq', 'power_capacitor', 3, 1), p(11, 'sq', 'power_pulse_dynamo', 3, 2)]), wires: [] };
    expect(codes(b)).toEqual([]);
    const d = createShipState(catalog, tuning, 1, b, 0).derived, L = d.power!;
    const banks = L.stores.filter((s) => s.kind === 'k');
    expect(banks).toHaveLength(1);
    expect([...banks[0].parts].sort((x, y) => x - y)).toEqual([9, 10, 11]);
    expect(banks[0].type).toBe('surge');
    expect(banks[0].label).toBe('S1');
    expect(banks[0].surge).toBeCloseTo(catalog.functions.get('power_pulse_dynamo')!.surge!, 9);
    expect(d.network[11]).toBe(-1);
    expect(d.networks.every((n) => !n.parts.includes(11))).toBe(true);
    // Empty, idle: the dynamo fills it, wires or no
    const s = L.stores.indexOf(banks[0]);
    let c: Charge = { core: 100, s: L.stores.map(() => 0) };
    for (let t = 0; t < 600; t++) c = powerTick(d, c, { thrusting: false, boosting: false }, tuning).charge;
    // (charge goes by thousandths of a percent a tick: near enough)
    expect(c.s[s]).toBeCloseTo(Math.min(100, (banks[0].surge! * 10 / banks[0].cap) * 100), 0);
  });

  it('a Pulse Dynamo alone against a gun powers it by touch', () => {
    // No generator, the core empty: the dynamo's 8/s runs the right Pip's 8/s
    const noReactor = (bp: Blueprint): Blueprint => ({ ...bp, parts: bp.parts.map((q) => (q.fn === 'power_cell_reactor' ? { ...q, fn: 'hull', material: 'alloy' } : q)) });
    const b = noReactor({ ...base([p(9, 'sq', 'power_pulse_dynamo', 3, 0)]), wires: [] });
    expect(codes(b)).toEqual([]);
    const shots = fire(b, 600, { core: 0, s: [] }).out.filter((x) => x.part === 2).length;
    const none = fire(noReactor({ ...base([]), wires: [] }), 600, { core: 0, s: [] }).out.filter((x) => x.part === 2).length;
    expect(shots).toBeGreaterThan(none * 5);
  });
});

describe('Surge: the reaction table', () => {
  const banked = () => base([p(9, 'sq', 'power_capacitor', 3, 0), p(10, 'sq', 'power_capacitor', 3, 1)]);

  it('names a reaction by category: guns charged shots, engines kicks, shields a flash restore; the duals their own', () => {
    const fn = (id: string) => catalog.functions.get(id);
    expect(surgeReaction(fn('cannon_pip'))).toBe('charged');
    expect(surgeReaction(fn('engine_ion_drive'))).toBe('kick');
    expect(surgeReaction(fn('shield_deflector'))).toBe('flash');
    expect(surgeReaction(fn('railgun_rail_driver'))).toBe('rail');
    expect(surgeReaction(fn('shield_flash_screen'))).toBe('screen');
    expect(surgeReaction(fn('power_battery'))).toBeNull();
  });

  it('a gun against a bank fires a charged shot after a pause, paid from the bank; one without a bank never does', () => {
    const b = banked();
    expect(codes(b)).toEqual([]);
    // Held: only the first shot (it sat loaded long enough) is charged
    const held = fire(b, 600);
    const right = held.out.filter((x) => x.part === 2), left = held.out.filter((x) => x.part === 1);
    expect(right.length).toBeGreaterThan(10);
    // (a gun spawns loaded but hasn't waited: the first is plain; firing in bursts with pauses, each burst's first is charged)
    expect(right.every((x) => x.damage === right[0].damage)).toBe(true);
    const bursts = fire(b, 1200, FULL_CHARGE, 120);
    const charged = bursts.out.filter((x) => x.part === 2 && x.damage > 1.01);
    expect(charged.length).toBeGreaterThan(3);
    expect(charged[0].damage).toBeCloseTo(st.chargedDamage, 6);
    expect(bursts.out.filter((x) => x.part === 1).every((x) => x.damage <= 1.0001)).toBe(true);
    expect(left.every((x) => x.damage <= 1.0001)).toBe(true);
  });

  it('a shield against a bank is put back half way when it breaks; a Flash Screen all the way', () => {
    const mk = (fn: string) => base([p(9, 'sq', fn, 3, 1), p(10, 'sq', 'power_capacitor', 3, 0), p(11, 'sq', 'power_capacitor', 4, 0)]);
    for (const [fn, share] of [['shield_deflector', st.flash.share], ['shield_flash_screen', st.flash.screen]] as const) {
      const b = mk(fn);
      expect(codes(b)).toEqual([]);
      const d = createShipState(catalog, tuning, 1, b, 0).derived;
      expect(d.shieldMax).toBeGreaterThan(0);
      expect(bankFor(d, 9)).toBeGreaterThanOrEqual(0);
      const r = flashRestore(d, FULL_CHARGE, tuning)!;
      expect(r.restore).toBeCloseTo(d.shieldMax * share, 6);
      const s = bankFor(d, 9), cap = d.power!.stores[s].cap;
      expect((cap * (100 - r.charge.s[s])) / 100).toBeCloseTo(r.restore * st.flash.costPerPoint, 3);
      // An empty bank puts nothing back
      expect(flashRestore(d, { core: 100, s: d.power!.stores.map(() => 0) }, tuning)).toBeNull();
    }
    // A shield touching no bank: nothing
    const plain = createShipState(catalog, tuning, 1, base([p(9, 'sq', 'shield_deflector', 3, 1)]), 0).derived;
    expect(flashRestore(plain, FULL_CHARGE, tuning)).toBeNull();
  });

  it('engines against a bank kick while boosting: a dash every few ticks, a packet from the bank each', () => {
    const b = base([p(9, 'sq', 'power_capacitor', 2, 2), p(10, 'sq', 'power_capacitor', -1, 2)]);
    expect(codes(b)).toEqual([]);
    const K = { friction: FRICTION, boostFactor: BOOST_FACTOR, worldSize: WORLD_SIZE };
    const go = (bp: Blueprint, tick: number) => {
      const d = createShipState(catalog, tuning, 1, bp, 0).derived;
      const body = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0 };
      const r = stepFlight(body, { forward: true, backward: false, left: false, right: false, boost: true, targetAngle: -Math.PI / 2 }, d, tuning, { charge: FULL_CHARGE, drainRate: 1, tick }, K);
      return { v: Math.hypot(body.vx, body.vy), r, d };
    };
    const kick = go(b, st.kickEvery * 3), between = go(b, st.kickEvery * 3 + 1);
    expect(kick.v).toBeGreaterThan(between.v * 1.5);
    // (no bank, no kick)
    expect(go(base([]), st.kickEvery * 3).v).toBeCloseTo(go(base([]), st.kickEvery * 3 + 1).v, 9);
    // Paid from the banks against the engines
    const banks = kick.d.power!.stores.map((s, i) => (s.kind === 'k' ? i : -1)).filter((i) => i >= 0);
    expect(banks.some((s) => kick.r.charge.s[s] < 100)).toBe(true);
  });
});

describe('Surge: the Rail Driver', () => {
  // A core with a Rail Driver ahead of it (its back against the core), a Cell Reactor at its left wired into it, and two
  // capacitors against its right side (one bank, wired so its circuit charges it)
  const rail = (caps = true, wired = true): Blueprint => ({
    name: 'rail', catalogVersion: 1,
    parts: [
      p(0, 'rect2', 'core', 0, 0),
      p(1, 'block2', 'railgun_rail_driver', 0, -2, { facing: 'N' }),
      p(2, 'sq', 'power_cell_reactor', -1, 0),
      p(3, 'sq', 'hull', -1, -1),
      ...(caps ? [p(4, 'sq', 'power_capacitor', 2, -2), p(5, 'sq', 'power_capacitor', 2, -1)] : []),
    ],
    wires: wired ? [[-1, -1, 0, -1], [-1, 0, -1, -1], ...(caps ? [[1, -1, 2, -1]] as [number, number, number, number][] : [])] : [],
  });

  it('its bank sets each slug\'s punch: full, the most, a pierce more, and the bank emptied; no bank, the least', () => {
    expect(codes(rail())).toEqual([]);
    const ship = createShipState(catalog, tuning, 1, rail(), 0);
    const d = ship.derived;
    const s = bankFor(d, 1);
    expect(s).toBeGreaterThanOrEqual(0);
    const energy = { charge: powerTick(d, FULL_CHARGE, { thrusting: false, boosting: false, load: gunLoad(ship, 1) }, tuning).charge };
    const shots = stepGuns(ship, pose, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy }, 1, tuning).shots;
    expect(shots).toHaveLength(1);
    expect(shots[0].shot.damageScale).toBeCloseTo(st.rail.max, 6);
    expect(shots[0].pierce).toBe(1);
    expect(energy.charge.s[s]).toBe(0);
    // No bank: the least, no pierce
    const bare = createShipState(catalog, tuning, 1, rail(false), 0);
    const e2 = { charge: powerTick(bare.derived, FULL_CHARGE, { thrusting: false, boosting: false }, tuning).charge };
    const s2 = stepGuns(bare, pose, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy: e2 }, 1, tuning).shots;
    expect(s2[0].shot.damageScale).toBeCloseTo(st.rail.min, 6);
    expect(s2[0].pierce).toBeUndefined();
  });

  it('Steady holds its rails: off a wired circuit it doesn\'t fire', () => {
    const ship = createShipState(catalog, tuning, 1, rail(true, false), 0);
    expect(ship.derived.network[1]).toBe(-1);
    const energy = { charge: FULL_CHARGE };
    expect(stepGuns(ship, pose, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy }, 1, tuning).shots).toHaveLength(0);
  });
});
