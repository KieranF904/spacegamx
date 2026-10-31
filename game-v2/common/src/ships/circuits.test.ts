/**
 * Local circuits (docs/design/energy-system.md, Phase 1): circuits, discharge
 * rates, brownout, touch-fed capacitor banks, the core's store, splits, and the
 * migration promise: the library ships, the dev guests' and the starter never
 * brown out in a scripted fight, while deliberately bad layouts do.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Blueprint, PlacedPart, Rot } from './types.js';
import { parseBlueprint, validateBlueprint } from './blueprint.js';
import { rebuild, type ShipDerived } from './rebuild.js';
import { createShipState, type ShipState } from './state.js';
import type { ShipTuning } from './tuning.js';
import { stepGuns } from './guns.js';
import { BROWNOUT, FULL_CHARGE, chargeTotal, circuitCharges, gunLoad, loadTest, packCharge, powerTick, remapCharge, unpackCharge, type Charge } from './energy.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';
import { autoWire } from './wires.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');

function p(uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart {
  return { uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra };
}
const design = (path: string): Blueprint => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints', path), 'utf-8'));
const codes = (b: Blueprint) => validateBlueprint(catalog, b, tuning, null).errors.map((e) => e.code);

/** Every library design, the dev guests' and the starter (Sparrow T is the starter: it's in the library) */
const LIBRARY = [
  ...readdirSync(join(SHIP_DATA_DIR, 'blueprints')).filter((f) => f.endsWith('.json')),
  ...readdirSync(join(SHIP_DATA_DIR, 'blueprints/dev')).filter((f) => f.endsWith('.json')).map((f) => `dev/${f}`),
];

/** The same ship with stores that give without limit (the core's too): what it would do before discharge rates */
function unlimited(d: ShipDerived): ShipDerived {
  const L = d.power!;
  return { ...d, power: { ...L, stores: L.stores.map((s) => ({ ...s, rate: 1e12 })), core: L.core && { ...L.core, rate: 1e12, trickle: 1e12 } } };
}

interface FightLog { brownTicks: number; rateLimited: number; minShare: number; shots: number; boosted: number }

/**
 * A scripted fight, 40 s: thrusting all the time, a 1.5 s boost every 6 s,
 * every gun firing whenever it bears (the trigger held, the aim sweeping round so side and rear guns bear too), the guns'
 * own step, from full charge. Counts the ticks something browned out, and those where it did only because of a discharge
 * rate: the same fight on stores without limits gave more, while the ship still had over 5% of its charge (boosting a big
 * ship till its batteries are flat browns it out either way, as it always has).
 */
function fight(b: Blueprint, seconds = 40): FightLog {
  const run = (limited: boolean) => {
    const ship: ShipState = createShipState(catalog, tuning, 1, b, 0);
    const d = limited ? ship.derived : unlimited(ship.derived);
    ship.derived = d;
    const pose = { x: 0, y: 0, angle: -Math.PI / 2 };
    let c: Charge = FULL_CHARGE;
    const shares: number[] = [], totals: number[] = [];
    let shots = 0, boosted = 0;
    for (let t = 1; t <= seconds * 60; t++) {
      const s = t % 360;
      const boosting = s >= 30 && s < 120;
      // (as flight asks it: every engine draws while thrusting, whichever way: flight.ts)
      const r = powerTick(d, c, { thrusting: true, boosting, load: gunLoad(ship, t) }, tuning);
      c = r.charge;
      if (r.boost) boosted++;
      const energy = { charge: c };
      const aim = -Math.PI / 2 + Math.sin(t / 90) * Math.PI;
      shots += stepGuns(ship, pose, { firing: true, aimWorld: aim, aimDist: 0, energy }, t, tuning).shots.length;
      shares.push(Math.min(1, ...(c.eng ?? []), ...(c.gun ?? [])));
      totals.push(chargeTotal(d, c));
    }
    return { shares, totals, shots, boosted };
  };
  const real = run(true), ref = run(false);
  let brownTicks = 0, rateLimited = 0;
  real.shares.forEach((v, t) => {
    if (v < BROWNOUT) brownTicks++;
    if (v < ref.shares[t] - 0.005 && real.totals[t] > 5) rateLimited++;
  });
  return { brownTicks, rateLimited, minShare: Math.min(...real.shares), shots: real.shots, boosted: real.boosted };
}

describe('local circuits: migration', () => {
  it('every library ship, dev guest ship and the starter fights a scripted fight without a discharge rate ever biting', () => {
    const rows: string[] = [];
    for (const f of LIBRARY) {
      const b = design(f);
      const log = fight(b);
      const d = createShipState(catalog, tuning, 1, b, 0).derived;
      const L = d.power!;
      rows.push(`${f.padEnd(28)} circuits ${L.circuits.filter((c) => c.letter).length} · brownout ticks ${log.brownTicks}/2400 (rate-limited ${log.rateLimited}) · lowest share ${log.minShare.toFixed(2)} · `
        + `shots ${log.shots} · boosting ${log.boosted} · spare ${L.circuits.map((c) => c.spare.toFixed(0)).join('/')} engines ${d.energy.engineDraw.toFixed(0)} guns ${d.energy.weaponDraw.toFixed(0)} · `
        + `stores ${L.stores.map((x) => `${x.kind} ${x.cap.toFixed(0)}@${x.rate.toFixed(0)}/s`).join(', ') || 'none'} + core ${L.core?.cap}@${L.core?.rate}/s`);
      // (No discharge rate ever cuts what the old ship-wide batteries would have given)
      expect(log.rateLimited, `${f}: ${rows[rows.length - 1]}`).toBe(0);
    }
    console.log(rows.join('\n'));
  });

  it('the starter (Sparrow T) and the dev guests never brown out at all in that fight', () => {
    for (const f of ['sparrow-t.json', ...LIBRARY.filter((x) => x.startsWith('dev/'))]) {
      const log = fight(design(f));
      expect(log.brownTicks, f).toBe(0);
    }
  });

  it('auto-wired designs are one circuit, so they behave as before but for the rates', () => {
    for (const f of LIBRARY) {
      const d = createShipState(catalog, tuning, 1, design(f), 0).derived;
      const lettered = d.power!.circuits.filter((c) => c.letter);
      expect(lettered.length, f).toBeLessThanOrEqual(1);
      if (lettered.length) expect(lettered[0].main).toBe(true);
    }
  });
});

// The test ship: a core between two Pips, a Cell Reactor at the left (the left Pip touches it, so it's plugged in), a
// strip of hull, and two Ion Drives under the middle (nothing touching the reactor). Auto-wired, it's one circuit; the
// tests wire it by hand to split it, with room round it for what each adds.
//
//   y=0:  Pip(-1)  CORE(0,1)  Pip(2)
//   y=1:  R(-1)    h(0) h(1)  h(2)
//   y=2:           E(0) E(1)
const base = (extra: PlacedPart[] = [], wires?: Blueprint['wires']): Blueprint => ({
  name: 'test', catalogVersion: 1,
  parts: [
    p(0, 'rect2', 'core', 0, 0),
    p(1, 'sq', 'cannon_pip', -1, 0, { facing: 'N' }),
    p(2, 'sq', 'cannon_pip', 2, 0, { facing: 'N' }),
    p(3, 'sq', 'power_cell_reactor', -1, 1),
    p(4, 'sq', 'hull', 0, 1),
    p(5, 'sq', 'hull', 1, 1),
    p(6, 'sq', 'hull', 2, 1),
    p(7, 'sq', 'engine_ion_drive', 0, 2, { facing: 'S' }),
    p(8, 'sq', 'engine_ion_drive', 1, 2, { facing: 'S' }),
    ...extra,
  ],
  ...(wires ? { wires } : {}),
});
/** The reactor to the engines */
const ENGINES: [number, number, number, number][] = [[-1, 1, 0, 2], [0, 2, 1, 2]];
const pose = { x: 0, y: 0, angle: -Math.PI / 2 };
/** Shots each gun fires in `ticks` with the trigger held, from charge `c0`, idle engines */
function shoot(b: Blueprint, ticks: number, c0: (d: ShipDerived) => Charge): Record<number, number> {
  const ship = createShipState(catalog, tuning, 1, b, 0);
  const d = ship.derived;
  const n: Record<number, number> = {};
  let c = c0(d);
  for (let t = 1; t <= ticks; t++) {
    c = powerTick(d, c, { thrusting: false, boosting: false, load: gunLoad(ship, t) }, tuning).charge;
    for (const s of stepGuns(ship, pose, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy: { charge: c } }, t, tuning).shots) n[s.w.part] = (n[s.w.part] ?? 0) + 1;
  }
  return n;
}

describe('local circuits: the rules', () => {
  it('auto-wired, the test ship is one circuit with the core\'s store on it', () => {
    const b = base();
    expect(codes(b)).toEqual([]);
    const L = createShipState(catalog, tuning, 1, b, 0).derived.power!;
    expect(L.circuits.filter((c) => c.letter).map((c) => c.letter)).toEqual(['A']);
    expect(L.core!.circuit).toBe(L.circuitOf[3]);
  });

  it('each circuit keeps its own charge: a reactor on one circuit never charges another circuit\'s battery', () => {
    // The engines and a Battery wired together with no generator; the guns, the reactor and a Battery beside it on the other
    const b = base([p(9, 'sq', 'power_battery', 2, 2), p(10, 'sq', 'power_battery', -2, 1)],
      [[0, 2, 1, 2], [1, 2, 2, 2], [-1, 1, 0, 1], [0, 1, 1, 1], [1, 1, 2, 1], [2, 1, 2, 0]]);
    expect(codes(b)).toEqual([]);
    const d = createShipState(catalog, tuning, 1, b, 0).derived;
    const L = d.power!;
    expect(L.circuits.filter((c) => c.letter).length).toBe(2);
    const eng = L.circuits[L.circuitOf[7]], gun = L.circuits[L.circuitOf[2]];
    expect(eng).not.toBe(gun);
    expect(eng.generators.length).toBe(0);
    expect(gun.main).toBe(true);
    expect(eng.letter).toBe('B');
    // Both batteries half empty; idle a few seconds: only the reactor's own circuit's battery fills
    let c: Charge = { core: 100, s: L.stores.map(() => 50) };
    for (let t = 0; t < 300; t++) c = powerTick(d, c, { thrusting: false, boosting: false }, tuning).charge;
    expect(c.s[eng.pools.g]).toBeCloseTo(50, 6);
    expect(c.s[gun.pools.g]).toBeGreaterThan(90);
    // Thrusting drains only the engines' circuit's battery
    c = { core: 100, s: L.stores.map(() => 100) };
    for (let t = 0; t < 120; t++) c = powerTick(d, c, { thrusting: true, boosting: true, dir: [0, -1] }, tuning).charge;
    expect(c.s[eng.pools.g]).toBeLessThan(100);
    expect(c.s[gun.pools.g]).toBe(100);
    // (Asked only for engines pushing a way, those pushing elsewhere draw nothing: flight doesn't ask it that way, as before)
    const back = powerTick(d, FULL_CHARGE, { thrusting: true, boosting: false, dir: [0, 1] }, tuning);
    expect(back.charge.s[eng.pools.g]).toBe(100);
  });

  it('a store gives no more than its discharge rate: past it, the circuit browns out with charge still stored', () => {
    // The Galleon's engines and guns with its Fusion Plants taken out: a Heavy Bank (and the core) alone. The bank is full,
    // but it gives slowly
    // (wired as Auto-wire wired the real one)
    const g = design('galleon.json');
    g.wires = autoWire(design('galleon.json'), catalog).map((w) => [...w] as typeof w);
    g.parts.filter((q) => q.fn === 'power_fusion_plant').forEach((q) => Object.assign(q, { fn: 'hull', material: 'alloy' }));
    const d = createShipState(catalog, tuning, 1, g, 0).derived;
    // Boosting with every gun reloading
    const load = d.power!.feeds.map(() => 0);
    for (const w of d.weapons) load[d.power!.feedOf[w.part]] += d.power!.draw[w.part];
    const r = powerTick(d, FULL_CHARGE, { thrusting: true, boosting: true, dir: [0, -1], load }, tuning);
    expect(r.boost).toBe(true);
    // (Engines first: they get theirs, the guns what's left)
    expect(r.power).toBe(1);
    expect(Math.min(...r.charge.gun!)).toBeLessThan(BROWNOUT);
    expect(Math.min(...r.charge.gun!)).toBeGreaterThan(0);
    expect(chargeTotal(d, r.charge)).toBeGreaterThan(95);
    // Without the rates (the old batteries) it wouldn't have
    const free = powerTick(unlimited(d), FULL_CHARGE, { thrusting: true, boosting: true, dir: [0, -1], load }, tuning);
    expect(free.power).toBe(1);
    expect(Math.min(...free.charge.gun!)).toBe(1);
    // The load test shows it from the first moment
    const lt = loadTest(d, tuning, { fire: true, thrust: true, boost: true, seconds: 3 });
    const main = d.power!.circuits.findIndex((c) => c.main);
    expect(lt.circuits[main].guns).toBeLessThan(BROWNOUT);
    expect(lt.circuits[main].brownAt).toBe(0);
    // ...and the real Galleon passes it
    const ok = createShipState(catalog, tuning, 1, design('galleon.json'), 0).derived;
    expect(powerTick(ok, FULL_CHARGE, { thrusting: true, boosting: true, dir: [0, -1] }, tuning).power).toBe(1);
  });

  it('brownout: a gun on a circuit that can\'t keep up reloads slower', () => {
    // Both Pips cut off from the reactor: the left one unwired (it no longer touches it: the reactor moved down a cell), the
    // right one wired only to an empty Battery. They share the core's trickle, 12/s against the 16/s the two would draw
    const b: Blueprint = { ...base([p(9, 'sq', 'power_battery', 2, 2), p(10, 'sq', 'hull', -1, 1)], [[-1, 2, 0, 2], [0, 2, 1, 2], [2, 0, 2, 1], [2, 1, 2, 2]]) };
    b.parts[3] = { ...b.parts[3], y: 2 };
    expect(codes(b)).toEqual([]);
    const d = createShipState(catalog, tuning, 1, b, 0).derived, L = d.power!;
    expect(L.circuits[L.circuitOf[2]].main).toBe(false);
    expect(d.network[1]).toBe(-1);
    const n = shoot(b, 1200, (dd) => ({ core: 100, s: dd.power!.stores.map((s) => (s.circuit === L.circuitOf[2] ? 0 : 100)) }));
    const flatOut = 1200 / d.weapons.find((x) => x.part === 2)!.interval;
    for (const g of [1, 2]) {
      expect(n[g]).toBeGreaterThan(flatOut * 0.5);
      expect(n[g]).toBeLessThan(flatOut * 0.9);
    }
    // One alone on it keeps up (8/s of 12)
    const one = shoot(b, 1200, (dd) => ({ core: 100, s: dd.power!.stores.map(() => 100) }));
    expect(one[2]).toBeGreaterThan(flatOut * 0.95);
  });

  it('brownout: engines on a starved circuit push less', () => {
    // The engines wired to a Battery with no generator; drained, they live on the trickle (12/s against their 18/s)
    const b = base([p(9, 'sq', 'power_battery', 2, 2)], [[0, 2, 1, 2], [1, 2, 2, 2]]);
    expect(codes(b)).toEqual([]);
    const d = createShipState(catalog, tuning, 1, b, 0).derived, L = d.power!;
    const eng = L.circuitOf[7];
    const dry: Charge = { core: 100, s: L.stores.map((s) => (s.circuit === eng ? 0 : 100)) };
    const r = powerTick(d, dry, { thrusting: true, boosting: false, dir: [0, -1] }, tuning);
    expect(r.power).toBeLessThan(BROWNOUT);
    expect(r.power).toBeCloseTo(12 / 18, 2);
  });

  it('capacitors give only to what they touch, and touching ones make one bank', () => {
    // The right Pip on a circuit with no generator and two capacitors: touching it (one bank of two), or off to the side
    const touching = base([p(9, 'sq', 'power_capacitor', 3, 0), p(10, 'sq', 'power_capacitor', 3, 1)], [...ENGINES, [2, 0, 3, 0], [3, 0, 3, 1]]);
    const apart = base([p(9, 'sq', 'power_capacitor', 3, 1), p(10, 'sq', 'power_capacitor', 4, 1)], [...ENGINES, [2, 0, 2, 1], [2, 1, 3, 1], [3, 1, 4, 1]]);
    expect(codes(touching)).toEqual([]);
    expect(codes(apart)).toEqual([]);
    const L = createShipState(catalog, tuning, 1, touching, 0).derived.power!;
    const banks = L.stores.filter((s) => s.kind === 'k');
    expect(banks.length).toBe(1);
    expect([...banks[0].parts].sort((a, b) => a - b)).toEqual([9, 10]);
    expect(banks[0].feeds).toEqual([2]);
    const La = createShipState(catalog, tuning, 1, apart, 0).derived.power!;
    expect(La.stores.filter((s) => s.kind === 'k').every((s) => !s.feeds!.length)).toBe(true);
    // No generator and the core empty (so no trickle): the touching bank feeds the Pip, the one apart can't
    const noReactor = (b: Blueprint): Blueprint => ({ ...b, parts: b.parts.map((q) => (q.fn === 'power_cell_reactor' ? { ...q, fn: 'hull', material: 'alloy' } : q)) });
    const empty = (): Charge => ({ core: 0, s: [] });
    const a = shoot(noReactor(touching), 300, empty)[2] ?? 0, b = shoot(noReactor(apart), 300, empty)[2] ?? 0;
    expect(b).toBe(1);
    expect(a).toBeGreaterThan(10);
  });

  it('the core\'s store is a battery on the main circuit and a trickle to the rest; an unwired gun limps on it', () => {
    const d = createShipState(catalog, tuning, 1, design('sparrow-t.json'), 0).derived;
    const L = d.power!;
    expect(L.core).not.toBeNull();
    expect(L.circuits[L.core!.circuit].main).toBe(true);
    expect(L.core!.rate).toBeGreaterThan(L.core!.trickle * 5);
    const dd = createShipState(catalog, tuning, 1, base([], [...ENGINES]), 0).derived;
    expect(dd.network[2]).toBe(-1);
    expect(dd.satisfaction[2]).toBe(1);
    expect(dd.power!.circuits[dd.power!.circuitOf[2]].net).toBe(-1);
  });

  it('a split keeps each store\'s charge; a mended store comes back empty', () => {
    // Batteries on each side, all wired through the middle hull
    const b = base([p(9, 'sq', 'power_battery', 2, 2), p(10, 'sq', 'power_battery', -2, 1)], [...ENGINES, [-1, 1, 0, 1], [0, 1, 1, 1], [1, 1, 2, 1], [2, 1, 2, 2], [2, 1, 2, 0]]);
    expect(codes(b)).toEqual([]);
    const ship = createShipState(catalog, tuning, 1, b, 0);
    const before = ship.derived;
    expect(before.power!.circuits.filter((c) => c.letter).length).toBe(1);
    const c: Charge = { core: 60, s: before.power!.stores.map(() => 40) };
    // Shoot away the middle hull: the wire through it is cut, and the right side is a circuit of its own
    const after = rebuild({ catalog, tuning, blueprint: b, hp: ship.maxHp.map((m, i) => (i === 5 ? 0 : m)), maxHp: ship.maxHp, detached: ship.detached, rootMode: 'core' });
    expect(after.power!.circuits.filter((x) => x.letter).length).toBe(2);
    const moved = remapCharge(before, after, c);
    expect(moved.core).toBe(60);
    after.power!.stores.forEach((_, s) => expect(moved.s[s]).toBeCloseTo(40, 6));
    // Battery 9 shot off and mended: it comes back empty, the rest keep theirs
    const lost = rebuild({ catalog, tuning, blueprint: b, hp: ship.maxHp.map((m, i) => (i === 9 ? 0 : m)), maxHp: ship.maxHp, detached: ship.detached, rootMode: 'core' });
    const back = remapCharge(lost, before, remapCharge(before, lost, c));
    const P = before.power!;
    const held = P.stores.reduce((t, g, s) => t + (g.cap * back.s[s]) / 100, 0);
    const want = P.stores.flatMap((g) => g.parts).filter((i) => i !== 9).reduce((t, i) => t + P.partCap[i] * 0.4, 0);
    expect(held).toBeCloseTo(want, 3);
  });

  it('the snapshot carries every store group and the core, and unpacks to the same', () => {
    const d = createShipState(catalog, tuning, 1, design('galleon.json'), 0).derived;
    const c: Charge = { core: 33.3333, s: d.power!.stores.map((_, i) => 10 + i) };
    const packed = packCharge(d, c);
    const data: number[] = new Array(16).fill(0);
    data[1] = packed.total; data[10] = packed.core; data[11] = packed.groups.length; data.push(...packed.groups);
    const back = unpackCharge(data);
    expect(back.core).toBeCloseTo(33.33, 2);
    expect(back.s).toEqual(c.s);
    expect(unpackCharge([1, 2, 3])).toEqual({ core: 100, s: [] });
  });

  it('circuitCharges lists each lettered circuit and the core', () => {
    const d = createShipState(catalog, tuning, 1, design('galleon.json'), 0).derived;
    const cc = circuitCharges(d, FULL_CHARGE);
    expect(cc.some((x) => x.letter === 'A')).toBe(true);
    expect(cc[cc.length - 1].letter).toBe('core');
  });
});
