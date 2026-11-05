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
  BROWNOUT, CHARGE_GROUPS_AT, PILOT_ROW, FULL_CHARGE, bankCharges, chargeTotal, gunDrawFlatOut, gunLoad, loadTest, packCharge, powerTick, remapCharge, unpackCharge, type Charge,
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

/** Every pool-era design (the library before it moved to the ports core, kept as fixtures) and the dev guests' */
// (test-brownout.json is short of power on purpose; devTestShips.test.ts in the server covers the test-* ships)
const LIBRARY = [
  ...readdirSync(join(SHIP_DATA_DIR, 'blueprints/fixtures')).filter((f) => f.endsWith('.json')).map((f) => `fixtures/${f}`),
  ...readdirSync(join(SHIP_DATA_DIR, 'blueprints/dev')).filter((f) => f.endsWith('.json') && f !== 'test-brownout.json' && !f.startsWith('ports-')).map((f) => `dev/${f}`),
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
      // (Ports designs, the dev player remakes among them, have no pool or banks)
      if (b.power === 'ports') continue;
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
    for (const f of ['fixtures/sparrow-t.json', ...LIBRARY.filter((x) => x.startsWith('dev/guest-'))]) {
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

  it('a Conduit or a Diode (energy routing\'s relays) is no battery here: never pooled, never a bank, and lights no network', () => {
    // Wired to the reactor: the pool is the core's alone, with no bank
    const b = base([p(9, 'sq', 'power_conduit', -2, 1), p(10, 'sq', 'power_diode', -3, 1, { facing: 'E' })], [...ENGINES, [-1, 1, -2, 1], [-2, 1, -3, 1]]);
    expect(codes(b)).toEqual([]);
    const L = derived(b).power!;
    expect(L.pool.parts).toEqual([]);
    expect([L.pool.cap, L.pool.rate]).toEqual([L.pool.coreCap, L.pool.coreRate]);
    expect(L.banks.length).toBe(0);
    // The engines on a network with a Conduit and a Diode but no generator stay dark (a Battery there would light them)
    for (const fn of ['power_conduit', 'power_diode']) {
      const c = base([p(9, 'sq', fn, 2, 2, fn === 'power_diode' ? { facing: 'W' } : {})], [[0, 2, 1, 2], [1, 2, 2, 2]]);
      c.parts[3] = { ...c.parts[3], fn: 'hull', material: 'alloy' };
      expect(codes(c)).toEqual([]);
      expect(derived(c).satisfaction[7]).toBe(0);
    }
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
    const g = design('fixtures/galleon.json');
    const pile = catalog.functions.get('power_isotope_pile')!;
    g.parts.filter((q) => q.fn === 'power_fusion_plant').forEach((q) => Object.assign(q, { fn: pile.id, piece: 'round', material: pile.material }));
    const d = derived(g), L = d.power!;
    expect(L.pool.parts.length).toBeGreaterThan(0);
    const load = L.feeds.map(() => 0);
    for (const w of d.weapons) load[L.feedOf[w.part]] += L.draw[w.part];
    const r = powerTick(d, FULL_CHARGE, { thrusting: true, boosting: true, load }, tuning);
    expect(r.boost).toBe(true);
    // (Shared by what each asks: the guns get the same share as the engines)
    expect(r.power).toBeLessThan(BROWNOUT);
    for (const g of r.charge.gun!) expect(g).toBeCloseTo(r.power, 9);
    expect(chargeTotal(d, r.charge)).toBeGreaterThan(95);
    // Without the rates it wouldn't have
    const free = powerTick(unlimited(d), FULL_CHARGE, { thrusting: true, boosting: true, load }, tuning);
    expect(free.power).toBe(1);
    expect(Math.min(...free.charge.gun!)).toBe(1);
    // The load test shows it from the first moment; the real Galleon is fine
    const lt = loadTest(d, tuning, { fire: true, thrust: true, boost: true, seconds: 3 });
    expect(lt.guns).toBeLessThan(BROWNOUT);
    expect(lt.brownAt).toBe(0);
    expect(powerTick(derived(design('fixtures/galleon.json')), FULL_CHARGE, { thrusting: true, boosting: true, dir: [0, -1] }, tuning).power).toBe(1);
  });

  it('the Heavy Bank holds 450 and gives 150/s a cell (deeper a cell than any Mk I store); the Battery 200 and 600/s', () => {
    const L = derived(base([p(9, 'block2', 'power_heavy_bank', -3, 1), p(10, 'sq', 'power_battery', -1, 2)])).power!;
    const hb = catalog.functions.get('power_heavy_bank')!, bat = catalog.functions.get('power_battery')!;
    expect(hb.store).toBe(450);
    expect(hb.discharge).toBe(150);
    expect(bat.store).toBe(200);
    expect(bat.discharge).toBe(600);
    expect(L.pool.parts.sort()).toEqual([10, 9].sort());
    expect(L.partCap[9]).toBeGreaterThan(1000);
  });

  it('a bank not full asks the Output for its intake (the spare stream first, then the pool); the stream left refills the pool', () => {
    const b = base([p(9, 'sq', 'power_capacitor', 3, 0), p(10, 'sq', 'power_battery', -2, 1)]);
    const d = derived(b), L = d.power!;
    expect(L.banks.length).toBe(1);
    expect(L.banks[0].refills).toBe(true);
    // (A Capacitor takes 40/s a cell; the reactor's 35/s is less, so the pool pays the other 5/s)
    expect(L.banks[0].intake).toBeCloseTo(40, 6);
    expect(L.spare).toBeCloseTo(35, 6);
    const held = (x: Charge) => ({ pool: (x.g / 100) * L.pool.cap, bank: (x.b[0] / 100) * L.banks[0].cap });
    let c: Charge = { g: 20, b: [80] };
    const at0 = held(c);
    for (let t = 0; t < 30; t++) c = powerTick(d, c, { thrusting: false, boosting: false }, tuning).charge;
    expect(held(c).bank - at0.bank).toBeCloseTo(40 / 2, 1);
    expect(held(c).pool - at0.pool).toBeCloseTo(-5 / 2, 1);
    // Once the bank is full, all the stream goes to the pool
    for (let t = 0; t < 60; t++) c = powerTick(d, c, { thrusting: false, boosting: false }, tuning).charge;
    expect(c.b[0]).toBe(100);
    const at1 = held(c);
    for (let t = 0; t < 60; t++) c = powerTick(d, c, { thrusting: false, boosting: false }, tuning).charge;
    expect(held(c).pool - at1.pool).toBeCloseTo(35, 0);
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
    // (The other shares the Output with the engines and the bank's refill, by what each asks: slower, but every tick)
    expect(r.shots[1] ?? 0).toBeLessThan(r.shots[2]);
    expect(r.shots[1] ?? 0).toBeGreaterThan(r.shots[2] * 0.5);
  });

  it('a Drive Cell gives a Burst Strafer 2 full bursts on an empty pool', () => {
    const bp = design('fixtures/sparrow-t.json');
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
    const plain = design('fixtures/sparrow-t.json');
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
    data[1] = packed.total; data[PILOT_ROW.pool] = packed.g; data[PILOT_ROW.groups] = packed.groups.length; data.push(...packed.groups);
    const back = unpackCharge(data);
    expect(back.g).toBeCloseTo(33.33, 2);
    expect(back.b).toEqual(c.b);
    expect(unpackCharge([1, 2, 3])).toEqual({ g: 100, b: [] });
    expect(bankCharges(d, c).map((x) => x.kind)).toEqual(['pool', 'cap', 'drive']);
  });
});

describe('energy: proportional sharing (Kieran, 2026-11-04)', () => {
  /**
   * A bare power layout to put Kieran's numbers through the real powerTick: part 0 an engine drawing `eng`/s, part 1 a
   * gun (its draw is the load), the pool empty so the Output is `spare` alone; optionally a Drive Cell bank (100, gives
   * without limit) feeding the engine, `intake`/s in, at `pct`.
   */
  function bare(o: { spare: number; eng: number; bank?: { intake: number; pct: number } }): { d: ShipDerived; c: Charge; eng: number; gun: number } {
    const banked = !!o.bank;
    const power = {
      pool: { cap: 240, rate: 720, coreCap: 240, coreRate: 720, parts: [] },
      banks: banked ? [{ kind: 'drive', parts: [2], cap: 100, rate: 1e9, intake: o.bank!.intake, feeds: [0], shields: [], refills: true, dynamo: 0, dynamos: [] }] : [],
      spare: o.spare,
      feeds: banked ? [{ banks: [0] }, { banks: [] }] : [{ banks: [] }],
      feedOf: banked ? [0, 1, -1] : [0, 0, -1],
      bankOf: [-1, -1, banked ? 0 : -1],
      draw: [o.eng, 0, 0],
      boostDrain: [1, 0, 0],
      partCap: [0, 0, banked ? 100 : 0],
      pooled: [false, false, false],
    };
    const d = { power, energy: {}, thrusters: [{ part: 0, force: [0, -1] }] } as unknown as ShipDerived;
    return { d, c: { g: 0, b: banked ? [o.bank!.pct] : [] }, eng: power.feedOf[0], gun: power.feedOf[1] };
  }
  const tick = (x: ReturnType<typeof bare>, gunDraw: number, c = x.c) => powerTick(x.d, c, { thrusting: true, boosting: false, load: x.eng === x.gun ? [gunDraw] : [0, gunDraw] }, tuning);

  it('thrusters ask 10, weapons 20: short of the Output, the weapons get 2/3 of it and each gets the same share of its ask', () => {
    const x = bare({ spare: 15, eng: 10 });
    const r = tick(x, 20);
    // (15 of Output against 30 asked: everyone at half)
    expect(r.charge.eng![x.eng]).toBeCloseTo(0.5, 12);
    expect(r.charge.gun![x.gun]).toBeCloseTo(0.5, 12);
    const engGot = 10 * r.charge.eng![x.eng], gunGot = 20 * r.charge.gun![x.gun];
    expect(gunGot / (engGot + gunGot)).toBeCloseTo(2 / 3, 12);
    expect(r.power).toBeCloseTo(0.5, 12);
    // Within the Output, everyone gets all they ask
    const full = tick(bare({ spare: 30, eng: 10 }), 20);
    expect(full.charge.eng![0]).toBe(1);
    expect(full.charge.gun![0]).toBe(1);
  });

  it('a bank feeding the thrusters asks its intake (30) against the weapons\' 20: the thruster side gets 3/5 of a short Output, banked', () => {
    // The thrusters draw their 10 on the bank (it holds charge); the bank asks 30 to refill, the guns 20; the Output is 25
    const x = bare({ spare: 25, eng: 10, bank: { intake: 30, pct: 50 } });
    let c = x.c;
    for (let t = 0; t < 60; t++) {
      const r = tick(x, 20, c);
      c = r.charge;
      expect(r.charge.eng![x.eng]).toBe(1);
      // (25 of Output against 50 asked: the bank gets 15 = 3/5, the guns 10 = 2/5 of it)
      expect(r.charge.gun![x.gun]).toBeCloseTo(0.5, 12);
    }
    // In a second the bank took in 15 and gave the thrusters 10
    expect(c.b[0]).toBeCloseTo(55, 1);
    // A dry bank feeds nothing, so its thrusters ask for themselves too: 10 + 30 + 20 asked of 25
    const dry = bare({ spare: 25, eng: 10, bank: { intake: 30, pct: 0 } });
    const r0 = tick(dry, 20);
    expect(r0.charge.eng![dry.eng]).toBeCloseTo(25 / 60, 12);
    expect(r0.charge.gun![dry.gun]).toBeCloseTo(25 / 60, 12);
  });

  it('a bank raises its side\'s share: the more intake, the more of a short Output goes to what it feeds', () => {
    // (The weapons' share of 25 of Output, against thrusters that draw 10 on their bank)
    const gunShare = (intake: number) => tick(bare({ spare: 25, eng: 10, bank: { intake, pct: 50 } }), 20).charge.gun![1];
    // (No bank: 25 against 30 asked)
    const none = bare({ spare: 25, eng: 10 });
    expect(tick(none, 20).charge.gun![none.gun]).toBeCloseTo(25 / 30, 12);
    // (A bank that takes in 10, all the thrusters draw: the same split; 30: the guns get 2/5 of it; 60: 1/4)
    expect(gunShare(10)).toBeCloseTo(25 / 30, 12);
    expect(gunShare(30)).toBeCloseTo(0.5, 12);
    expect(gunShare(60)).toBeCloseTo(25 / 80, 12);
    // A full bank asks only to replace what it gave: no more than its side drew
    expect(tick(bare({ spare: 25, eng: 10, bank: { intake: 60, pct: 100 } }), 20).charge.gun![1]).toBeCloseTo(25 / 30, 12);
  });

  it('a boost held on an empty store gives the guns their share every tick (engines first left them nothing every other tick)', () => {
    // The Drum: 124 spare against 168 boosting and 24 of guns. A boost re-arms on each tick's trickle into the pool, so the
    // ticks alternate boosting and cruising; the guns now share both
    const d = derived(design('fixtures/drum.json')), L = d.power!;
    const load = L.feeds.map(() => 0);
    for (const w of d.weapons) load[L.feedOf[w.part]] += gunDrawFlatOut(w, L.draw[w.part]);
    let c: Charge = { g: 0, b: [] };
    let boosted = 0, minGun = 1;
    for (let t = 0; t < 600; t++) {
      const r = powerTick(d, c, { thrusting: true, boosting: true, load }, tuning);
      c = r.charge;
      if (r.boost) boosted++;
      for (let f = 0; f < L.feeds.length; f++) {
        if (load[f] <= 0) continue;
        minGun = Math.min(minGun, c.gun![f]);
        // (One share for engines and guns alike)
        expect(c.gun![f]).toBeCloseTo(r.power, 9);
      }
    }
    expect(boosted).toBeGreaterThan(200);
    expect(boosted).toBeLessThan(400);
    // (Boosting ticks: (124 + the trickle) / (168 + 24) of each ask; the cruising ones in full)
    expect(minGun).toBeGreaterThan(0.8);
  });
});

describe('engines with no boost (Vernier, Torch)', () => {
  /** A ship with the engine under the hull; the tri piece is turned and faced until it has a mount */
  const withEngine = (fn: string, piece: string): ShipDerived => {
    const bases = [p(20, 'sq', 'hull', 2, 1), p(21, 'sq', 'hull', 0, 1), p(22, 'sq', 'hull', 1, 1)];
    for (const rot of [0, 1, 2, 3] as Rot[]) for (const facing of ['N', 'E', 'S', 'W'] as const) {
      const b = base();
      b.parts = b.parts.filter((q) => q.fn !== 'engine_ion_drive' && q.fn !== 'hull');
      b.parts.push(...bases, piece === 'tri' ? p(23, piece, fn, 2, 2, { facing, rot }) : p(23, piece, fn, 0, 2, { facing: 'S' }));
      const d = createShipState(catalog, tuning, 1, b, 0).derived;
      if (d.thrusters.length === 1 && d.thrusters[0].part >= 0) return d;
    }
    throw new Error('no mount for ' + fn);
  };
  for (const [fn, piece] of [['engine_torch', 'rect2'], ['engine_vernier', 'tri']] as const) {
    it(`${fn}: thrust and draw are the same with boost held`, () => {
      const d = withEngine(fn, piece);
      expect(d.boostFactor).toBe(1);
      expect(d.boostDrain).toBe(0);
      const f = d.thrusters[0].force, m = Math.hypot(f[0], f[1]);
      expect(m).toBeGreaterThan(0);
      const dir: [number, number] = [-f[0] / m, -f[1] / m];
      const full: Charge = { g: 100, b: [] };
      const plain = powerTick(d, full, { thrusting: true, boosting: false, dir }, tuning);
      const held = powerTick(d, full, { thrusting: true, boosting: true, dir }, tuning);
      expect(held.charge.g).toBeCloseTo(plain.charge.g, 12);
      expect(held.power).toBe(plain.power);
    });
  }
});
