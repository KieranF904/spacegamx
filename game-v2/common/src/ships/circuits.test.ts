/**
 * The ship's pool and the banks (docs/design/rework-2026-11.md §2.1-2.3; circuits.ts, energy.ts): the pre-5896116
 * "powered" rule, one pool with an Output limit, Capacitor and Drive Cell banks that feed only what they touch and
 * refill only when wired to power (or a Pulse Dynamo touches them), splits, the snapshot, and the migration promise:
 * the library ships, the dev guests' and the starter never hit a discharge rate in a scripted fight.
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
import { stepShipPhysics } from './physics.js';
import type { FlightBody, FlightControls } from './flight.js';
import {
  BROWNOUT, CHARGE_GROUPS_AT, FULL_CHARGE, bankCharges, chargeTotal, gunLoad, loadTest, packCharge, powerTick, remapCharge, unpackCharge, type Charge,
} from './energy.js';
import { burstEnergy, DODGE_LEFT } from './features/strafer/strafer.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');

function p(uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart {
  return { uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra };
}
const design = (path: string): Blueprint => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints', path), 'utf-8'));
const codes = (b: Blueprint) => validateBlueprint(catalog, b, tuning, null).errors.map((e) => e.code);

/** Every library design, the dev guests' and the starter (Sparrow T is the starter: it's in the library) */
// (test-brownout.json is short of power on purpose; devTestShips.test.ts in the server covers the test-* ships)
const LIBRARY = [
  ...readdirSync(join(SHIP_DATA_DIR, 'blueprints')).filter((f) => f.endsWith('.json')),
  ...readdirSync(join(SHIP_DATA_DIR, 'blueprints/dev')).filter((f) => f.endsWith('.json') && f !== 'test-brownout.json').map((f) => `dev/${f}`),
];

/** The same ship with stores that give without limit (the pool's and the banks'): what it would do without discharge rates */
function unlimited(d: ShipDerived): ShipDerived {
  const L = d.power!;
  return { ...d, power: { ...L, pool: { ...L.pool, rate: 1e12 }, banks: L.banks.map((b) => ({ ...b, rate: 1e12 })) } };
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

describe('energy: migration', () => {
  it('every library ship, dev guest ship and the starter fights a scripted fight without a discharge rate ever biting', () => {
    const rows: string[] = [];
    for (const f of LIBRARY) {
      const b = design(f);
      const log = fight(b);
      const d = createShipState(catalog, tuning, 1, b, 0).derived;
      const L = d.power!;
      rows.push(`${f.padEnd(28)} brownout ticks ${log.brownTicks}/2400 (rate-limited ${log.rateLimited}) · lowest share ${log.minShare.toFixed(2)} · `
        + `shots ${log.shots} · boosting ${log.boosted} · spare ${L.spare.toFixed(0)} engines ${d.energy.engineDraw.toFixed(0)} guns ${d.energy.weaponDraw.toFixed(0)} · `
        + `pool ${L.pool.cap.toFixed(0)}@${L.pool.rate.toFixed(0)}/s · banks ${L.banks.map((x) => `${x.kind} ${x.cap.toFixed(0)}@${x.rate.toFixed(0)}/s`).join(', ') || 'none'}`);
      // (No discharge rate ever cuts what stores without limits would have given)
      expect(log.rateLimited, `${f}: ${rows[rows.length - 1]}`).toBe(0);
    }
    console.log(rows.join('\n'));
  });

  it('the starter (Sparrow T) and the dev guests never brown out at all in that fight', () => {
    for (const f of ['sparrow-t.json', ...LIBRARY.filter((x) => x.startsWith('dev/guest-'))]) {
      const log = fight(design(f));
      expect(log.brownTicks, f).toBe(0);
    }
  });
});

// The test ship: a core between two Pips, a Cell Reactor at the left (the left Pip touches it, so it's plugged in), a
// strip of hull, and two Ion Drives under the middle. Auto-wired, it's one network with the reactor on it.
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
/** Shots each gun fires in `ticks` with the trigger held, from charge `c0` (engines thrusting and boosting if asked) */
function shoot(b: Blueprint, ticks: number, c0: (d: ShipDerived) => Charge, move: { thrusting: boolean; boosting: boolean } = { thrusting: false, boosting: false }): { shots: Record<number, number>; charge: Charge } {
  const ship = createShipState(catalog, tuning, 1, b, 0);
  const d = ship.derived;
  const n: Record<number, number> = {};
  let c = c0(d);
  for (let t = 1; t <= ticks; t++) {
    c = powerTick(d, c, { ...move, load: gunLoad(ship, t) }, tuning).charge;
    for (const s of stepGuns(ship, pose, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy: { charge: c } }, t, tuning).shots) n[s.w.part] = (n[s.w.part] ?? 0) + 1;
  }
  return { shots: n, charge: c };
}
const derived = (b: Blueprint) => createShipState(catalog, tuning, 1, b, 0).derived;

describe('energy: the pool and the powered rule', () => {
  it('the pool is the core\'s store plus the batteries on a powered network; Output is spare generation plus its rate', () => {
    // A Battery against the reactor (plugged in) and one wired to nothing
    const b = base([p(9, 'sq', 'power_battery', -2, 1), p(10, 'sq', 'power_battery', 3, 1)], [...ENGINES, [-1, 1, -2, 1]]);
    expect(codes(b)).toEqual([]);
    const L = derived(b).power!;
    expect(L.pool.parts).toEqual([9]);
    expect(L.pool.cap).toBeCloseTo(240 + 200, 6);
    expect(L.pool.rate).toBeCloseTo(720 + 600, 6);
    expect(L.banks.length).toBe(0);
    expect(L.spare).toBeGreaterThan(0);
  });

  it('as before 5896116: an engine or gun runs if its network has a generator or a battery, and one on no network is dark', () => {
    // No generator (hull for the reactor); the right Pip wired to nothing; the engines wired to a Battery only
    const b = base([p(9, 'sq', 'power_battery', 2, 2)], [[0, 2, 1, 2], [1, 2, 2, 2]]);
    b.parts[3] = { ...b.parts[3], fn: 'hull', material: 'alloy' };
    expect(codes(b)).toEqual([]);
    const d = derived(b);
    expect(d.network[2]).toBe(-1);
    expect(d.satisfaction[2]).toBe(0);
    // (on a network with a battery but no generator: they run, on the ship's pool, though the battery isn't in it)
    expect(d.network[7]).toBeGreaterThanOrEqual(0);
    expect(d.satisfaction[7]).toBe(1);
    expect(d.power!.pool.parts).toEqual([]);
  });

  it('short of Output, every gun gets the same share and reloads that much slower', () => {
    // No reactor (hull instead) and the pool nearly dry: both Pips share what the pool gives
    const b = base();
    b.parts[3] = { ...b.parts[3], fn: 'hull', material: 'alloy' };
    const d = derived(b);
    expect(d.power!.spare).toBe(0);
    const r = shoot(b, 600, () => ({ g: 100, b: [] }));
    const flatOut = 600 / d.weapons.find((x) => x.part === 2)!.interval;
    // (240 in the pool against 16/s: plenty for 10 s)
    expect(r.shots[1]).toBeGreaterThan(flatOut * 0.95);
    const dry = shoot(b, 600, () => ({ g: 0, b: [] }));
    // (Loaded, each fires its first shot; then nothing comes in)
    expect(dry.shots[1]).toBe(1);
    expect(dry.shots[2]).toBe(1);
  });

  it('a store gives no more than its rate: past its Output a boosting, firing ship browns out with charge still stored', () => {
    // The Galleon with Isotope Piles for its Fusion Plants: little spare, so its Output is mostly the core's and Heavy Banks' rates
    const g = design('galleon.json');
    const pile = catalog.functions.get('power_isotope_pile')!;
    g.parts.filter((q) => q.fn === 'power_fusion_plant').forEach((q) => Object.assign(q, { fn: pile.id, piece: 'round', material: pile.material }));
    const d = derived(g), L = d.power!;
    expect(L.pool.parts.length).toBeGreaterThan(0);
    const load = L.feeds.map(() => 0);
    for (const w of d.weapons) load[L.feedOf[w.part]] += L.draw[w.part];
    const r = powerTick(d, FULL_CHARGE, { thrusting: true, boosting: true, load }, tuning);
    expect(r.boost).toBe(true);
    // (Engines first: the guns get no more of a share than they do)
    expect(r.power).toBeLessThan(BROWNOUT);
    expect(Math.max(...r.charge.gun!)).toBeLessThanOrEqual(r.power + 1e-9);
    expect(chargeTotal(d, r.charge)).toBeGreaterThan(95);
    // Without the rates it wouldn't have
    const free = powerTick(unlimited(d), FULL_CHARGE, { thrusting: true, boosting: true, load }, tuning);
    expect(free.power).toBe(1);
    expect(Math.min(...free.charge.gun!)).toBe(1);
    // The load test shows it from the first moment; the real Galleon is fine
    const lt = loadTest(d, tuning, { fire: true, thrust: true, boost: true, seconds: 3 });
    expect(lt.guns).toBeLessThan(BROWNOUT);
    expect(lt.brownAt).toBe(0);
    expect(powerTick(derived(design('galleon.json')), FULL_CHARGE, { thrusting: true, boosting: true, dir: [0, -1] }, tuning).power).toBe(1);
  });

  it('the Heavy Bank holds 300 and gives 150/s a cell; the Battery 200 and 600/s', () => {
    const L = derived(base([p(9, 'block2', 'power_heavy_bank', -3, 1), p(10, 'sq', 'power_battery', -1, 2)])).power!;
    const hb = catalog.functions.get('power_heavy_bank')!, bat = catalog.functions.get('power_battery')!;
    expect(hb.store).toBe(300);
    expect(hb.discharge).toBe(150);
    expect(bat.store).toBe(200);
    expect(bat.discharge).toBe(600);
    expect(L.pool.parts.sort()).toEqual([10, 9].sort());
    expect(L.partCap[9]).toBeGreaterThan(1000);
  });

  it('spare generation refills the pool and the banks, emptiest first', () => {
    const b = base([p(9, 'sq', 'power_capacitor', 3, 0), p(10, 'sq', 'power_battery', -2, 1)]);
    const d = derived(b);
    expect(d.power!.banks.length).toBe(1);
    expect(d.power!.banks[0].refills).toBe(true);
    let c: Charge = { g: 20, b: [80] };
    for (let t = 0; t < 30; t++) c = powerTick(d, c, { thrusting: false, boosting: false }, tuning).charge;
    // (The pool, emptier, takes it all while the bank is fuller)
    expect(c.g).toBeGreaterThan(20);
    expect(c.b[0]).toBeCloseTo(80, 6);
  });
});

describe('energy: banks', () => {
  it('touching Capacitors make one bank that feeds the guns it touches; it never feeds an engine, and kinds never mix', () => {
    const b = base([p(9, 'sq', 'power_capacitor', 3, 0), p(10, 'sq', 'power_capacitor', 3, 1), p(11, 'sq', 'power_drive_cell', 3, 2), p(12, 'sq', 'power_capacitor', 2, 2), p(13, 'sq', 'engine_ion_drive', 2, 3, { facing: 'S' })]);
    expect(codes(b)).toEqual([]);
    const L = derived(b).power!;
    // Banks number by their lowest part: Capacitors 9+10, the Drive Cell, the lone Capacitor 12
    expect(L.banks.map((x) => [x.kind, x.parts])).toEqual([['cap', [9, 10]], ['drive', [11]], ['cap', [12]]]);
    expect(L.banks[0].feeds).toEqual([2]);
    // (The Capacitor at (2,2) touches the Ion Drive at (1,2) and the one below it: it feeds neither)
    expect(L.banks[2].feeds).toEqual([]);
    expect(L.banks[0].cap).toBeCloseTo(320, 6);
    expect(L.banks[0].rate).toBeCloseTo(4000, 6);
    expect(L.feeds[L.feedOf[2]].banks).toEqual([0]);
    expect(L.feeds[L.feedOf[1]].banks).toEqual([]);
  });

  it('a pool drained by boosting leaves a gun bank full, and the gun it feeds still reloads at full speed', () => {
    const b = base([p(9, 'sq', 'power_capacitor', 3, 0), p(10, 'sq', 'power_capacitor', 3, 1)]);
    const d = derived(b);
    let c: Charge = FULL_CHARGE;
    for (let t = 0; t < 1800; t++) c = powerTick(d, c, { thrusting: true, boosting: true }, tuning).charge;
    expect(c.g).toBeLessThan(2);
    expect(c.b[0]).toBe(100);
    // Firing while boosting on the empty pool: the banked Pip keeps its pace, the other barely reloads
    const r = shoot(b, 600, () => c, { thrusting: true, boosting: true });
    const flatOut = 600 / d.weapons.find((x) => x.part === 2)!.interval;
    expect(r.shots[2]).toBeGreaterThan(flatOut * 0.95);
    // (The other shares what's left of the Output with nothing behind it)
    expect(r.shots[1] ?? 0).toBeLessThan(r.shots[2] * 0.75);
    expect(r.charge.b[0]).toBeLessThan(100);
  });

  it('a Drive Cell gives a Burst Strafer 2 full bursts on an empty pool', () => {
    const bp = design('sparrow-t.json');
    bp.parts.push(
      { uid: 60, piece: 'sq', fn: 'engine_burst_strafer', material: 'steel', x: 3, y: 0, rot: 0, flip: false, facing: 'E' } as PlacedPart,
      { uid: 62, piece: 'sq', fn: 'power_drive_cell', material: 'steel', x: 3, y: -1, rot: 0, flip: false } as PlacedPart,
    );
    const d = derived(bp);
    const L = d.power!;
    expect(L.banks.length).toBe(1);
    expect(L.banks[0].kind).toBe('drive');
    expect(L.banks[0].feeds.length).toBe(1);
    expect(burstEnergy(d, DODGE_LEFT)).toBeCloseTo(140, 0);
    const NONE: FlightControls = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: -Math.PI / 2 };
    const body: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0 };
    let c: Charge = { g: 0, b: [100] };
    const kicks: number[] = [];
    const s = d.fx!.strafe!;
    for (let n = 0; n < 3; n++) {
      const before = body.vx;
      for (let i = 0; i < s.cooldown; i++) c = stepShipPhysics(body, { ...NONE, dodge: i < 4 }, d, tuning, { charge: c, drainRate: 1 }).charge;
      kicks.push(Math.abs(body.vx - before));
      body.vx = body.vy = 0;
    }
    // Reference: the same burst with all the power it wants
    const ref: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0 };
    for (let i = 0; i < s.cooldown; i++) stepShipPhysics(ref, { ...NONE, dodge: i < 4 }, d, tuning, { charge: FULL_CHARGE, drainRate: 0 });
    const full = Math.abs(ref.vx);
    expect(full).toBeGreaterThan(0);
    expect(kicks[0]).toBeCloseTo(full, 3);
    expect(kicks[1]).toBeCloseTo(full, 3);
    // (The third has only what's left in the cell and the ship's spare generation)
    expect(kicks[2]).toBeLessThan(full * 0.9);
    // Without the Drive Cell, the first burst on an empty pool is refused or weak
    const plain = design('sparrow-t.json');
    plain.parts.push({ uid: 60, piece: 'sq', fn: 'engine_burst_strafer', material: 'steel', x: 3, y: 0, rot: 0, flip: false, facing: 'E' } as PlacedPart);
    const dp = derived(plain), b0: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0 };
    let c0: Charge = { g: 0, b: [] };
    for (let i = 0; i < s.cooldown; i++) c0 = stepShipPhysics(b0, { ...NONE, dodge: i < 4 }, dp, tuning, { charge: c0, drainRate: 1 }).charge;
    expect(Math.abs(b0.vx)).toBeLessThan(full * 0.5);
  });

  it('a bank refills only wired to power or from a Pulse Dynamo touching it (10/s), and a bank that can do neither stays empty', () => {
    // The right Pip's Capacitor bank wired to nothing (hand wires: just the engines)
    const loose = base([p(9, 'sq', 'power_capacitor', 3, 0)], [...ENGINES]);
    const Ll = derived(loose).power!;
    expect(Ll.banks[0].refills).toBe(false);
    let c: Charge = { g: 100, b: [0] };
    for (let t = 0; t < 600; t++) c = powerTick(derived(loose), c, { thrusting: false, boosting: false }, tuning).charge;
    expect(c.b[0]).toBe(0);
    // A Pulse Dynamo against it: 10 a second
    const dyn = base([p(9, 'sq', 'power_capacitor', 3, 0), p(10, 'sq', 'power_pulse_dynamo', 3, 1)], [...ENGINES]);
    const dd = derived(dyn);
    expect(dd.power!.banks[0].dynamo).toBeCloseTo(10, 6);
    expect(dd.power!.banks[0].dynamos).toEqual([10]);
    c = { g: 100, b: [0] };
    for (let t = 0; t < 600; t++) c = powerTick(dd, c, { thrusting: false, boosting: false }, tuning).charge;
    expect((c.b[0] / 100) * dd.power!.banks[0].cap).toBeCloseTo(100, 0);
    // (auto-wired, it's on the reactor's network: it refills from spare)
    expect(derived(base([p(9, 'sq', 'power_capacitor', 3, 0)])).power!.banks[0].refills).toBe(true);
  });

  it('a split keeps each store\'s charge; a mended store comes back empty', () => {
    // Two Capacitors in a row against the right Pip, then a third: shoot the middle one and the bank splits
    const b = base([p(9, 'sq', 'power_capacitor', 3, 0), p(10, 'sq', 'power_capacitor', 4, 0), p(11, 'sq', 'power_capacitor', 5, 0), p(12, 'sq', 'power_battery', -2, 1)]);
    const ship = createShipState(catalog, tuning, 1, b, 0);
    const before = ship.derived;
    expect(before.power!.banks.length).toBe(1);
    const c: Charge = { g: 60, b: [40] };
    const after = rebuild({ catalog, tuning, blueprint: b, hp: ship.maxHp.map((m, i) => (i === 10 ? 0 : m)), maxHp: ship.maxHp, detached: ship.detached, rootMode: 'core' });
    const moved = remapCharge(before, after, c);
    expect(moved.g).toBeCloseTo(60, 6);
    // (The cell past the cut is off the ship: what's left is one bank of one)
    for (let k = 0; k < after.power!.banks.length; k++) expect(moved.b[k]).toBeCloseTo(40, 6);
    // The Battery shot off and mended: it comes back empty, the core keeps its share
    const lost = rebuild({ catalog, tuning, blueprint: b, hp: ship.maxHp.map((m, i) => (i === 12 ? 0 : m)), maxHp: ship.maxHp, detached: ship.detached, rootMode: 'core' });
    const back = remapCharge(lost, before, remapCharge(before, lost, c));
    expect((back.g / 100) * before.power!.pool.cap).toBeCloseTo(0.6 * 240, 1);
  });

  it('the snapshot carries the pool and each bank (1 + banks groups), and unpacks to the same', () => {
    const d = derived(base([p(9, 'sq', 'power_capacitor', 3, 0), p(10, 'sq', 'power_drive_cell', 2, 2)]));
    expect(d.power!.banks.length).toBe(2);
    const c: Charge = { g: 33.3333, b: [10, 11] };
    const packed = packCharge(d, c);
    expect(packed.groups.length).toBe(3);
    const data: number[] = new Array(CHARGE_GROUPS_AT).fill(0);
    data[1] = packed.total; data[10] = packed.g; data[11] = packed.groups.length; data.push(...packed.groups);
    const back = unpackCharge(data);
    expect(back.g).toBeCloseTo(33.33, 2);
    expect(back.b).toEqual(c.b);
    expect(unpackCharge([1, 2, 3])).toEqual({ g: 100, b: [] });
    expect(bankCharges(d, c).map((x) => x.kind)).toEqual(['pool', 'cap', 'drive']);
  });
});
