import { describe, it, expect } from 'vitest';
import type { Blueprint, InventoryStub, PlacedPart, Rot, Side } from './types.js';
import { parseBlueprint, serializeBlueprint, validateBlueprint } from './blueprint.js';
import { allocateFlow, rebuild } from './rebuild.js';
import { createShipState, damagePart } from './state.js';
import { healthFactor, ShipTuning } from './tuning.js';
import { stepFlight, FlightBody, jumpTuning, jumpPhase, jumpDistance, jumpCoast, jumpScaleFor, jumpDriveStats } from './flight.js';
import { pilotJumpStep, NO_FIELDS } from './jumpFields.js';
import { stepShipPhysics } from './physics.js';
import { powerTick, spend, payMining, MINE_SEGMENT, MINE_CYCLE, FULL_CHARGE, type Charge } from './energy.js';
import { stepGuns } from './guns.js';
import { stepFixedGunAim } from './turret.js';
import { partWeaponDef } from './launch.js';
import { baseWeaponDps } from './rating.js';
import { pulseProfile, pulseIntensity, beamFalloff, effectiveRange } from './pulse.js';
import { partStats } from './partStats.js';
import { addedWires, autoWire, cellKey, isPowerPart, SEGMENTS_PER_SPOOL, wireCells, wireSpools } from './wires.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FRICTION, BOOST_FACTOR, WORLD_SIZE } from '../constants.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const inventory: InventoryStub = readShipJson('inventory.json');
const sparrowText = readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8');
const sparrow = () => parseBlueprint(sparrowText);
const prospectorBp = () => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/prospector.json'), 'utf-8'));
const K = { friction: FRICTION, boostFactor: BOOST_FACTOR, worldSize: WORLD_SIZE };

function p(uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart {
  return { uid, piece, fn, material: 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra };
}
const bp = (parts: PlacedPart[]): Blueprint => ({ name: 'test', catalogVersion: 1, parts });
const derive = (b: Blueprint, hpFn?: (max: number, i: number) => number) => {
  const s = createShipState(catalog, tuning, 1, b, 0);
  if (hpFn) {
    s.hp = s.maxHp.map(hpFn);
    s.derived = rebuild({ catalog, tuning, blueprint: b, hp: s.hp, maxHp: s.maxHp, detached: s.detached, rootMode: 'core' });
  }
  return s.derived;
};
const codes = (b: Blueprint, inv: InventoryStub | null = null) => validateBlueprint(catalog, b, tuning, inv).errors.map((e) => e.code);

// ---------------------------------------------------------------------------
describe('blueprints (M2)', () => {
  it('Sparrow T is valid with the inventory stub', () => {
    expect(validateBlueprint(catalog, sparrow(), tuning, inventory).errors).toEqual([]);
  });

  it('the concept ships (Bulwark, Arrow, Drum) are valid and fully attached', () => {
    for (const name of ['bulwark', 'arrow', 'drum']) {
      const b = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, `blueprints/${name}.json`), 'utf-8'));
      expect(validateBlueprint(catalog, b, tuning, inventory).errors, name).toEqual([]);
      const d = derive(b);
      expect(d.alive.every(Boolean), name).toBe(true);
      expect(d.weapons.length, name).toBeGreaterThan(0);
      expect(d.maxThrust.forward, name).toBeGreaterThan(0);
    }
  });

  it('serialises without loss', () => {
    const b = sparrow();
    expect(parseBlueprint(serializeBlueprint(b))).toEqual(b);
    expect(serializeBlueprint(parseBlueprint(serializeBlueprint(b)))).toBe(serializeBlueprint(b));
    // The checked-in file is already canonical
    expect(serializeBlueprint(b)).toBe(sparrowText.replace(/\r\n/g, '\n'));
  });

  it('sorts parts by uid when serialising', () => {
    const b = sparrow();
    b.parts.reverse();
    expect(parseBlueprint(serializeBlueprint(b)).parts.map((q) => q.uid)).toEqual(sparrow().parts.map((q) => q.uid));
  });

  describe('each validation rule rejects its bad case', () => {
    it('one core', () => {
      const b = sparrow();
      b.parts.find((q) => q.uid === 7)!.fn = 'core';
      expect(codes(b)).toContain('coreCount');
      const none = sparrow();
      none.parts[0].fn = 'hull';
      expect(codes(none)).toContain('coreCount');
    });
    it('no overlaps', () => {
      const b = sparrow();
      b.parts.push(p(20, 'tri', 'hull', -1, 1));
      expect(codes(b)).toContain('overlap');
    });
    it('every part reachable from the core', () => {
      const b = sparrow();
      b.parts.push(p(20, 'sq', 'hull', 10, 10));
      expect(codes(b)).toContain('unreachable');
    });
    it('facing edges free', () => {
      const b = sparrow();
      b.parts.push(p(20, 'sq', 'hull', 0, 3)); // right behind thruster 5
      expect(codes(b)).toContain('facingBlocked');
    });
    it('thrusters and weapons need a facing with a straight edge', () => {
      const b = sparrow();
      delete b.parts.find((q) => q.uid === 2)!.facing;
      expect(codes(b)).toContain('facingMissing');
      const c = sparrow();
      // tri rot 2 has legs N and E only
      c.parts.find((q) => q.uid === 9)!.fn = 'thruster';
      c.parts.find((q) => q.uid === 9)!.facing = 'S' as Side;
      expect(codes(c)).toContain('facingMissing');
    });
    it('at most 255 parts', () => {
      const parts = [p(0, 'sq', 'core', 0, 0)];
      for (let i = 1; i < 256; i++) parts.push(p(i % 256, 'sq', 'hull', i, 0));
      expect(codes(bp(parts))).toContain('tooManyParts');
    });
    it('unique uids', () => {
      const b = sparrow();
      b.parts[1].uid = 0;
      expect(codes(b)).toContain('duplicateUid');
    });
    it('every piece owned in the inventory stub', () => {
      expect(codes(sparrow(), { ...inventory, pieces: { ...inventory.pieces, tri: 3 } })).toContain('notOwned');
      expect(codes(sparrow(), { ...inventory, materials: ['steel'] })).toContain('materialNotOwned');
      expect(codes(sparrow(), null)).toEqual([]);
    });
    it('function allowed on the piece', () => {
      const b = sparrow();
      b.parts.find((q) => q.uid === 1)!.fn = 'generator'; // cap can't be a generator
      expect(codes(b)).toContain('functionNotAllowed');
    });
    it('catalog version matches', () => {
      expect(codes({ ...sparrow(), catalogVersion: 99 })).toContain('catalogVersion');
    });
  });
});

// ---------------------------------------------------------------------------
describe('rebuild: structure and derived stats (M3)', () => {
  it('mass, centre of mass and inertia match hand-calculated fixtures', () => {
    // Two alloy unit squares side by side: J = 2 × (1/6 + 0.5²) cells⁴
    const a = derive(bp([p(0, 'sq', 'core', 0, 0), p(1, 'sq', 'hull', 1, 0)]));
    expect(a.mass).toBeCloseTo(2, 9);
    expect(a.com[0]).toBeCloseTo(1, 9);
    expect(a.com[1]).toBeCloseTo(0.5, 9);
    expect(a.inertia).toBeCloseTo(2 * (1 / 6 + 0.25) * tuning.cellSize ** 2, 6);

    // Steel (1.4) core over an alloy square
    const b = derive(bp([p(0, 'sq', 'core', 0, 0, { material: 'steel' }), p(1, 'sq', 'hull', 0, 1)]));
    const comY = (1.4 * 0.5 + 1.5) / 2.4;
    expect(b.mass).toBeCloseTo(2.4, 9);
    expect(b.com[1]).toBeCloseTo(comY, 9);
    const J = 1.4 * (1 / 6 + (0.5 - comY) ** 2) + (1 / 6 + (1.5 - comY) ** 2);
    expect(b.inertia).toBeCloseTo(J * tuning.cellSize ** 2, 6);

    // A lone quarter disk: area π/4, centroid 4/(3π) from the corner
    const c = derive(bp([p(0, 'round', 'core', 0, 0)]));
    expect(c.mass).toBeCloseTo(Math.PI / 4, 9);
    expect(c.com[0]).toBeCloseTo(4 / (3 * Math.PI), 4);
    expect(c.com[1]).toBeCloseTo(1 - 4 / (3 * Math.PI), 4);
  });

  it('torque signs: a right-side thruster pushing forward turns the ship counter-clockwise', () => {
    const d = derive(bp([
      p(0, 'sq', 'core', 0, 0),
      p(1, 'sq', 'generator', 0, 1),
      p(2, 'sq', 'thruster', 1, 0, { facing: 'S' }),
    ]));
    expect(d.thrusters).toHaveLength(1);
    const thrust = catalog.functions.get('thruster')!.thrust!;
    expect(d.thrusters[0].force).toEqual([0, -thrust]);
    // r = (2/3, -1/3) cells, F = (0, -thrust): τ = rx·Fy − ry·Fx = −(2/3)·thrust → × cellSize
    const tau = (2 / 3) * thrust * tuning.cellSize;
    expect(d.thrusters[0].torque).toBeCloseTo(-tau, 9);
    expect(d.maxTorque.cw).toBeCloseTo(tuning.flight.gyroTorque, 9);
    expect(d.maxTorque.ccw).toBeCloseTo(tuning.flight.gyroTorque + tuning.flight.thrusterTorqueGain * tau, 9);
  });

  it('a left-side thruster gives clockwise torque', () => {
    const d = derive(bp([
      p(0, 'sq', 'core', 1, 0),
      p(1, 'sq', 'generator', 1, 1),
      p(2, 'sq', 'thruster', 0, 0, { facing: 'S' }),
    ]));
    expect(d.thrusters[0].torque).toBeGreaterThan(0);
  });

  it("Sparrow T is symmetric, fully powered and fires at its fixed Pips' own rate", () => {
    // (Feel against the legacy triangle is checked in the engine: ships.engine.test.ts)
    const d = derive(sparrow());
    expect(d.alive.every(Boolean)).toBe(true);
    expect(d.maxThrust.forward).toBeGreaterThan(d.maneuverForce);
    expect(d.maxTorque.cw).toBeCloseTo(d.maxTorque.ccw, 9);
    expect(d.weapons.map((w) => w.mount)).toEqual(['fixed', 'fixed']);
    // (At the rate its legacy fixed guns had: a model's interval is its own)
    expect(d.weapons.map((w) => w.interval)).toEqual([15, 15]);
  });

  it('removing a side thruster gives a lopsided turn', () => {
    const b = sparrow();
    b.parts = b.parts.filter((q) => q.uid !== 5); // left thruster
    const d = derive(b);
    expect(d.maxTorque.cw).toBeLessThan(d.maxTorque.ccw);

    // Fly it: equal-size turns left and right take different times
    const ticksToTurn = (target: number) => {
      const body: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0 };
      for (let t = 1; t < 600; t++) {
        stepFlight(body, { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: target },
          d, tuning, { fuel: 0, drainRate: 0 }, K);
        if (Math.abs(body.angle - target) < 0.02 && Math.abs(body.angVel) < 0.005) return t;
      }
      return 600;
    };
    const right = ticksToTurn(-Math.PI / 2 + 1.5);
    const left = ticksToTurn(-Math.PI / 2 - 1.5);
    expect(right).toBeGreaterThan(left);
  });
});

// ---------------------------------------------------------------------------
describe('flow network and solver (M4)', () => {
  it('reproduces the spec example: 98 against 110 (priorities 1, 2, 2, 3)', () => {
    const f = tuning.fixtures.flowExample;
    const out = allocateFlow(f.supply, f.demands.map((draw, i) => ({ draw, priority: f.priorities[i] })));
    out.forEach((v, i) => expect(v).toBeCloseTo(f.expected[i], 9));
  });

  // Numbers come from the data so retuning doesn't break the logic checks (the starter's models, and the legacy parts enemies fly)
  const FN = (id: string) => catalog.functions.get(id)!;
  const PRODUCE = FN('power_cell_reactor').produce!;
  const THRUST_DEMAND = FN('engine_ion_drive').demand!;
  const WEAPON_DEMAND = FN('cannon_pip').demand!;
  const LEGACY_PRODUCE = FN('generator').produce!;
  const LEGACY_THRUST = FN('thruster').demand!;
  const LEGACY_WEAPON = FN('weapon').demand!;
  /** The starter with one Cell Reactor where it has two (the other a hull plate) */
  const oneReactor = () => {
    const b = sparrow();
    const r = b.parts.filter((q) => q.fn === 'power_cell_reactor');
    expect(r).toHaveLength(2);
    Object.assign(r[1], { fn: 'hull' });
    return b;
  };
  const reactorIndex = (b: Blueprint) => b.parts.findIndex((q) => q.fn === 'power_cell_reactor');

  it('separate networks are solved separately: unwired, only what touches a generator is plugged in; engines and guns draw on the battery', () => {
    const d = derive({ ...bp([
      p(0, 'sq', 'core', 0, 0),
      p(1, 'sq', 'generator', 1, 0),
      p(2, 'sq', 'weapon', 2, 0, { facing: 'E' }),
      p(3, 'sq', 'hull', 0, 1),
      p(4, 'sq', 'generator', 0, 2),
      p(5, 'sq', 'thruster', -1, 2, { facing: 'W' }),
      p(6, 'sq', 'thruster', 1, 2, { facing: 'E' }),
      p(7, 'sq', 'thruster', 0, 3, { facing: 'S' }),
    ]), wires: [] });
    expect(d.alive.every(Boolean)).toBe(true);
    expect(d.networks).toHaveLength(2);
    // (The hull plate touches the lower generator: plugged into its network, though it does nothing there)
    expect(d.network[3]).toBe(d.network[4]);
    expect(d.network[2]).toBe(d.network[1]);
    expect(d.network[1]).not.toBe(d.network[4]);
    expect(d.networks.every((n) => n.powered)).toBe(true);
    // Engines and guns aren't shared out the supply: they run at full power off the battery (energy.ts)
    expect(LEGACY_PRODUCE).toBeLessThan(3 * LEGACY_THRUST);
    expect(d.satisfaction[2]).toBe(1);
    for (const i of [5, 6, 7]) expect(d.satisfaction[i]).toBe(1);
    // Both generators' power is spare (nothing steady draws on it); the engines draw three thrusters' worth
    expect(d.energy.spare).toBeCloseTo(2 * LEGACY_PRODUCE, 9);
    expect(d.energy.engineDraw).toBeCloseTo(3 * LEGACY_THRUST, 9);
    expect(d.energy.weaponDraw).toBeCloseTo(LEGACY_WEAPON, 9);
  });

  it('an undersized generator: full power while the battery lasts, then only what the generators spare', () => {
    const full = derive(sparrow());
    const b = oneReactor();
    expect(codes(b)).toEqual([]);
    // (One Cell Reactor, at half its HP, makes less than the starter's guns and engines draw)
    const gi = reactorIndex(b);
    const supply = PRODUCE * healthFactor(0.5, tuning);
    const thrustDraw = 2 * THRUST_DEMAND;
    const weaponDraw = 2 * WEAPON_DEMAND;
    expect(supply).toBeLessThan(thrustDraw + weaponDraw);

    const weak = derive(b, (max, i) => (i === gi ? max * 0.5 : max));
    // Built the same: full thrust and fire rate (the battery covers the shortfall)
    expect(weak.maxThrust.forward).toBeCloseTo(full.maxThrust.forward, 9);
    expect(weak.weapons[0].interval).toBeCloseTo(full.weapons[0].interval, 9);
    expect(weak.energy.spare).toBeCloseTo(supply, 9);
    expect(weak.energy.engineDraw).toBeCloseTo(thrustDraw, 9);
    expect(weak.energy.weaponDraw).toBeCloseTo(weaponDraw, 9);
    const thrust = { thrusting: true, boosting: false };
    // General-pool energy held, for a charge
    const g = (d: typeof weak, c: Charge) => (d.energy.max * c.g) / 100;
    const half: Charge = { g: 50, d: 0, w: 0 };
    // Cruising: one generator keeps two thrusters going, and the rest charges the battery
    const c1 = powerTick(weak, half, thrust, tuning);
    expect(c1.power).toBe(1);
    expect(g(weak, c1.charge)).toBeCloseTo(g(weak, half) + (supply - thrustDraw) / 60, 2);
    // Boosting draws far more: full power on a charged battery, which drains by the shortfall
    const boost = { ...thrust, boosting: true };
    const need = thrustDraw * (1 + 2.8 * weak.boostDrain);
    const b1 = powerTick(weak, half, boost, tuning);
    expect(b1.boost).toBe(true);
    expect(b1.power).toBe(1);
    expect(g(weak, b1.charge)).toBeCloseTo(g(weak, half) - (need - supply) / 60, 2);
    // ...and needs stored charge
    expect(powerTick(weak, { g: 0, d: 0, w: 0 }, boost, tuning).boost).toBe(false);

    // Damage that generator to a fifth of its HP: output drops on the health curve, and so does the spare power
    const damaged = derive(b, (max, i) => (i === gi ? max * 0.2 : max));
    const dSupply = PRODUCE * healthFactor(0.2, tuning);
    expect(damaged.energy.spare).toBeCloseTo(dSupply, 9);
    expect(dSupply).toBeLessThan(thrustDraw);
    // Dry: the engines get what streams in, and nothing is left to charge the batteries
    const empty: Charge = { g: 0, d: 0, w: 0 };
    const dry = powerTick(damaged, empty, thrust, tuning);
    expect(dry.power).toBeCloseTo(dSupply / thrustDraw, 9);
    expect(dry.charge.g).toBe(0);
    // Idle: the battery charges with the spare power
    const idle = powerTick(damaged, empty, { thrusting: false, boosting: false }, tuning);
    expect(g(damaged, idle.charge)).toBeCloseTo(dSupply / 60, 2);
  });

  it('thrusting on empty batteries, the engines take every bit of power and the guns stay silent', () => {
    const b = oneReactor();
    const ship = createShipState(catalog, tuning, 1, b, 0);
    // Damage the generator so the engines need more than it makes
    const gi = reactorIndex(b);
    ship.derived = derive(b, (max, i) => (i === gi ? max * 0.2 : max));
    expect(ship.derived.energy.spare).toBeLessThan(ship.derived.energy.engineDraw);
    const pose = { x: 0, y: 0, angle: -Math.PI / 2 };
    let charge: Charge = { g: 0, d: 0, w: 0 };
    let fired = 0;
    for (let t = 1; t < 240; t++) {
      charge = powerTick(ship.derived, charge, { thrusting: true, boosting: false }, tuning).charge;
      const energy = { charge };
      fired += stepGuns(ship, pose, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy }, t, tuning).shots.length;
      charge = energy.charge;
    }
    expect(fired).toBe(0);
    expect(charge.g).toBe(0);
  });

  it('drive batteries feed only the engines, weapon batteries only the guns; the general battery both', () => {
    // (One reactor: a boost draws more than it makes)
    const b = oneReactor();
    // Two of the hull squares become a Drive Cell and a Capacitor (each in its own material)
    const hulls = b.parts.filter((q) => q.fn === 'hull' && q.piece === 'sq');
    let made = 0;
    for (const h of hulls) {
      if (made >= 2) break;
      const was = { fn: h.fn, material: h.material };
      const m = FN(made === 0 ? 'power_drive_cell' : 'power_capacitor');
      Object.assign(h, { fn: m.id, material: m.material });
      const d = derive(b);
      if ((made === 0 ? d.energy.driveMax : d.energy.weaponMax) > 0 && codes(b).length === 0) made++;
      else Object.assign(h, was);
    }
    expect(made).toBe(2);
    const d = derive(b);
    expect(d.energy.driveMax).toBeGreaterThan(0);
    expect(d.energy.weaponMax).toBeGreaterThan(0);
    // Guns spend the weapon battery first, and never the drive battery
    const full: Charge = { g: 100, d: 100, w: 100 };
    const a = spend(d, full, d.energy.weaponMax * 0.5)!;
    expect(a.w).toBeCloseTo(50, 2);
    expect(a.g).toBe(100);
    expect(a.d).toBe(100);
    // More than the weapon and general batteries hold: refused, though the drive battery is full
    expect(spend(d, { g: 0, d: 100, w: 0 }, 1)).toBeNull();
    // Boosting drains the drive battery first, and never the weapon battery
    const boosted = powerTick(d, full, { thrusting: true, boosting: true }, tuning);
    expect(boosted.charge.d).toBeLessThan(100);
    expect(boosted.charge.w).toBe(100);
    // Engines on an empty drive and general battery run on what streams in, even with a full weapon battery
    const t = powerTick(d, { g: 0, d: 0, w: 100 }, { thrusting: true, boosting: true }, tuning);
    expect(t.boost).toBe(false);
    expect(t.charge.w).toBe(100);
  });

  it('mining lasers pay for a quarter-second segment at a time: no charge, no beam', () => {
    const b = prospectorBp();
    const ship = createShipState(catalog, tuning, 1, b, 0);
    expect(ship.derived.miners.length).toBeGreaterThan(0);
    const cost = (ship.derived.energy.minerDraw * MINE_SEGMENT) / 60;
    // A segment's start: paid in full, then free until the next
    const c = { charge: { g: 100, d: 100, w: 100 } as Charge };
    expect(payMining(ship, true, MINE_SEGMENT * 10, c)).toBe(true);
    const after = c.charge.g;
    expect((ship.derived.energy.max * (100 - after)) / 100).toBeCloseTo(cost, 2);
    expect(payMining(ship, true, MINE_SEGMENT * 10 + 5, c)).toBe(true);
    expect(c.charge.g).toBe(after);
    // The next segment, with nothing stored: the beam stops
    const dry = { charge: { g: 0, d: 0, w: 0 } as Charge };
    expect(payMining(ship, true, MINE_SEGMENT * 11, dry)).toBe(false);
    // Starting mid-segment pays only for what's left of it
    const fresh = createShipState(catalog, tuning, 2, b, 0);
    const m = { charge: { g: 100, d: 100, w: 100 } as Charge };
    payMining(fresh, true, MINE_SEGMENT * 20 + 10, m);
    expect((fresh.derived.energy.max * (100 - m.charge.g)) / 100).toBeCloseTo((cost * (MINE_SEGMENT - 10)) / MINE_SEGMENT, 2);
  });

  it('every shot spends the battery: a gun it can\'t pay for waits', () => {
    const ship = createShipState(catalog, tuning, 1, sparrow(), 0);
    const pose = { x: 0, y: 0, angle: -Math.PI / 2 };
    const w = ship.derived.weapons[0];
    expect(w.energy).toBeGreaterThan(0);
    // Empty: nothing fires
    const dry = { charge: { g: 0, d: 0, w: 0 } as Charge };
    expect(stepGuns(ship, pose, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy: dry }, 1, tuning).shots).toHaveLength(0);
    // Charged: they fire, and each shot's energy comes off
    const charged = { charge: { g: 100, d: 100, w: 100 } as Charge };
    const { shots } = stepGuns(ship, pose, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy: charged }, 2, tuning);
    expect(shots.length).toBeGreaterThan(0);
    const spent = shots.reduce((t, s) => t + s.w.energy, 0);
    expect((ship.derived.energy.max * (100 - charged.charge.g)) / 100).toBeCloseTo(spent, 2);
  });

  // A core, a generator under it, a strip of hull to its right and a gun at the end, wired along the strip; another strip
  // below it holds it all on (unwired)
  const strip = (wires: [number, number, number, number][] | undefined, extra: PlacedPart[] = []) => ({
    ...bp([
      p(0, 'sq', 'core', 0, 0),
      p(1, 'sq', 'power_cell_reactor', 0, 1),
      p(2, 'sq', 'hull', 1, 0),
      p(3, 'sq', 'hull', 2, 0),
      p(4, 'sq', 'hull', 3, 0),
      p(5, 'sq', 'cannon_pip', 4, 0, { facing: 'E' }),
      ...[1, 2, 3, 4].map((x) => p(9 + x, 'sq', 'hull', x, 1)),
      ...extra,
    ]),
    ...(wires ? { wires } : {}),
  });
  const RUN: [number, number, number, number][] = [[0, 1, 1, 0], [1, 0, 2, 0], [2, 0, 3, 0], [3, 0, 4, 0]];

  it('a wire carries power from a generator to what it reaches; cut the block under it and what lies beyond loses its power', () => {
    const whole = derive(strip(RUN));
    expect(whole.satisfaction[5]).toBe(1);
    expect(whole.network[5]).toBe(whole.network[1]);
    expect(whole.wireLive.every(Boolean)).toBe(true);
    expect(whole.wireNet.every((n) => n === whole.network[1])).toBe(true);
    expect(whole.networks[whole.network[1]].powered).toBe(true);
    // (Hull it runs over is on the network too: a part joins every network with a wire node in it)
    expect(whole.network[3]).toBe(whole.network[1]);
    // The middle plate shot off: the segments either side of it go dark, and the gun is cut off
    const cut = derive(strip(RUN), (max, i) => (i === 3 ? 0 : max));
    expect(cut.alive[3]).toBe(false);
    expect(cut.alive[5]).toBe(true);
    expect(cut.wireLive).toEqual([true, false, false, true]);
    expect(cut.wireNet[1]).toBe(-1);
    expect(cut.satisfaction[5]).toBe(0);
    expect(cut.network[5]).not.toBe(cut.network[1]);
    // No wires at all: the gun touches nothing that makes power
    expect(derive(strip([])).satisfaction[5]).toBe(0);
  });

  it('a part touching a generator is plugged straight into it; modules touching modules share nothing else', () => {
    const b = bp([
      p(0, 'sq', 'core', 0, 0),
      p(1, 'sq', 'power_cell_reactor', 1, 0),
      p(2, 'sq', 'cannon_pip', 2, 0, { facing: 'N' }),
      p(3, 'sq', 'cannon_pip', 3, 0, { facing: 'N' }),
    ]);
    const d = derive({ ...b, wires: [] });
    expect(d.satisfaction[2]).toBe(1);
    // (The second gun touches only the first)
    expect(d.satisfaction[3]).toBe(0);
    expect(d.network[3]).toBe(-1);
    // A wire into it from the first gun's cell: the first gun bridges it to the generator
    expect(derive({ ...b, wires: [[2, 0, 3, 0]] }).satisfaction[3]).toBe(1);
  });

  it('batteries count only on a network with a generator; guns run off any battery on their network', () => {
    const battery = p(6, 'sq', 'power_battery', 5, 1);
    const store = FN('power_battery').store!;
    const core = tuning.energy?.coreCapacity ?? 240;
    const wired = derive(strip([...RUN, [4, 0, 5, 1]], [battery]));
    expect(wired.energy.max).toBe(Math.round(core + store));
    // Cut off from the generator: the battery's capacity doesn't count, though the gun wired to it still runs off the ship's battery
    const i6 = 10;
    const cut = derive(strip([...RUN, [4, 0, 5, 1]], [battery]), (max, i) => (i === 3 ? 0 : max));
    expect(cut.alive[i6]).toBe(true);
    expect(cut.network[i6]).toBe(cut.network[5]);
    expect(cut.networks[cut.network[i6]].powered).toBe(false);
    expect(cut.energy.max).toBe(core);
    expect(cut.satisfaction[5]).toBe(1);
  });

  it('a steady load shares out the supply on its own network, not the whole ship', () => {
    // A scanner wired to the generator gets what it draws; one off on its own gets nothing, however much the other spares
    const d = derive(strip([...RUN, [4, 0, 5, 1]], [p(6, 'sq', 'utility_scanner', 5, 1), p(7, 'sq', 'utility_scanner', 0, 2)]));
    expect(d.satisfaction[10]).toBe(1);
    // (The second sits beside the generator, so it's plugged in: move it off it and it's on no network)
    expect(d.satisfaction[11]).toBe(1);
    const off = derive(strip([...RUN, [4, 0, 5, 1]], [p(6, 'sq', 'utility_scanner', 5, 1), p(7, 'sq', 'utility_scanner', 1, 2)]));
    expect(off.alive[11]).toBe(true);
    expect(off.network[11]).toBe(-1);
    expect(off.satisfaction[11]).toBe(0);
  });

  it('auto-wiring (a design with no wires) reaches every part that makes, stores or draws power', () => {
    for (const name of ['sparrow-t', 'prospector', 'corsair', 'bastion', 'hauler', 'lancer']) {
      const b = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, `blueprints/${name}.json`), 'utf-8'));
      expect(b.wires, name).toBeUndefined();
      const d = derive(b);
      expect(d.wires.length, name).toBeGreaterThan(0);
      expect(d.wireLive.every(Boolean), name).toBe(true);
      b.parts.forEach((q, i) => {
        if (!isPowerPart(catalog.functions.get(q.fn))) return;
        expect(d.network[i], `${name} ${q.fn} ${q.uid}`).toBeGreaterThanOrEqual(0);
        expect(d.networks[d.network[i]].powered, `${name} ${q.fn} ${q.uid}`).toBe(true);
        expect(d.satisfaction[i], `${name} ${q.fn} ${q.uid}`).toBeGreaterThan(0);
      });
      // The same wiring each time (for the same layout), each segment between neighbouring cells under the ship
      expect(autoWire(b, catalog)).toBe(autoWire(parseBlueprint(JSON.stringify(b)), catalog));
      const cells = wireCells(catalog, b);
      for (const [x0, y0, x1, y1] of d.wires) {
        expect(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))).toBe(1);
        expect(cells.has(cellKey(x0, y0)) && cells.has(cellKey(x1, y1))).toBe(true);
      }
    }
  });

  it('wires are saved with the design: cleaned (neighbours only, each once) and costed in spools', () => {
    const b = { ...strip(RUN), wires: [[1, 0, 0, 1], [0, 1, 1, 0], [2, 0, 4, 0], [3, 0, 2, 0], [3, 0, 4, 0]] as [number, number, number, number][] };
    const back = parseBlueprint(serializeBlueprint(b));
    // (Each the lower cell first, in rows)
    expect(back.wires).toEqual([[2, 0, 3, 0], [3, 0, 4, 0], [0, 1, 1, 0]]);
    expect(parseBlueprint(serializeBlueprint(strip(undefined))).wires).toBeUndefined();
    expect(wireSpools(0)).toBe(0);
    expect(wireSpools(1)).toBe(1);
    expect(wireSpools(SEGMENTS_PER_SPOOL)).toBe(1);
    expect(wireSpools(SEGMENTS_PER_SPOOL + 1)).toBe(2);
    expect(addedWires(RUN, [...RUN, [4, 0, 4, 1]])).toBe(1);
    expect(addedWires(undefined, RUN)).toBe(4);
  });

  it('generator output follows the health curve', () => {
    const b = sparrow(), gi = reactorIndex(b);
    const d = derive(b, (max, i) => (i === gi ? max * 0.5 : max));
    const net = d.networks[d.network[gi]];
    // (The starter's two Cell Reactors, side by side: one network)
    expect(net.parts).toContain(b.parts.findIndex((q, i) => i !== gi && q.fn === 'power_cell_reactor'));
    expect(net.supply).toBeCloseTo(PRODUCE * healthFactor(0.5, tuning) + PRODUCE, 9);
  });
});

describe('health curve and dirty bands', () => {
  it('health(f) = 0 at 0, 0.25 + 0.75 f otherwise', () => {
    expect(healthFactor(0, tuning)).toBe(0);
    expect(healthFactor(1, tuning)).toBe(1);
    expect(healthFactor(0.5, tuning)).toBeCloseTo(0.625, 9);
    expect(healthFactor(0.01, tuning)).toBeCloseTo(0.2575, 9);
  });

  it('marks the ship dirty only on a band crossing or death', () => {
    const s = createShipState(catalog, tuning, 1, sparrow(), 0);
    const max = s.maxHp[7];
    damagePart(s, 7, max * 0.1, tuning);
    expect(s.dirty).toBe(false);
    damagePart(s, 7, max * 0.2, tuning); // 70% → crossed 75%
    expect(s.dirty).toBe(true);
    s.dirty = false;
    damagePart(s, 7, max, tuning);
    expect(s.hp[7]).toBe(0);
    expect(s.dirty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('pre-made ships', () => {
  const PREMADE = ['corsair', 'lancer', 'galleon', 'bastion', 'hammerhead'];

  it.each(PREMADE)('%s is valid with the inventory, fully powered, and can fly', (file) => {
    const b = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, `blueprints/${file}.json`), 'utf-8'));
    expect(validateBlueprint(catalog, b, tuning, inventory).errors).toEqual([]);
    const d = derive(b);
    expect(d.alive.every(Boolean)).toBe(true);
    for (const w of d.weapons) expect(d.satisfaction[w.part]).toBe(1);
    for (const t of d.thrusters) expect(d.satisfaction[t.part]).toBe(1);
    expect(d.maxThrust.forward / d.mass).toBeGreaterThan(0.06);
  });

  it('bigger ships are slower', () => {
    const accel = (f: string) => {
      const d = derive(parseBlueprint(readFileSync(join(SHIP_DATA_DIR, `blueprints/${f}.json`), 'utf-8')));
      return d.maxThrust.forward / d.mass;
    };
    expect(accel('lancer')).toBeGreaterThan(accel('galleon'));
    expect(accel('galleon')).toBeGreaterThan(accel('bastion'));
  });
});

// ---------------------------------------------------------------------------
describe('jump drive', () => {
  const jt = jumpTuning(tuning);
  /** The starter's own drive: its reach and cooldown (its core's coil against its hull) */
  const { jumpRange: R, jumpCooldown: CD } = derive(sparrow());
  const fly = (ticks: number, jump: (t: number) => boolean, angle = 0.6, jumpDist = 0, jumpBoost = 1, bp = sparrow()) => {
    const d = derive(bp);
    const body: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle, angVel: 0, jump: 0 };
    const trace: number[] = [];
    for (let t = 0; t < ticks; t++) {
      stepFlight(body, { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: angle, jump: jump(t), jumpDist }, d, tuning, { fuel: 0, drainRate: 0 }, { ...K, jumpBoost });
      trace.push(body.jump!);
    }
    return { body, trace };
  };

  it('charges, then flies as far as the drive reaches along the nose, then cools down and is ready again', () => {
    const total = jt.chargeTicks + jt.burnTicks;
    // The burn lets go at exitSpeed, short of the mark; the coast carries the ship the rest of the way
    const burnt = fly(total - 1, () => true).body; // (its last burn tick)
    expect(Math.hypot(burnt.vx, burnt.vy)).toBeCloseTo(jt.exitSpeed, 3);
    expect(Math.hypot(burnt.x, burnt.y)).toBeLessThan(R - jumpCoast(jt, FRICTION) * 0.9);
    const { body, trace } = fly(total + 600, (t) => t < total);
    const dist = Math.hypot(body.x, body.y);
    expect(dist).toBeGreaterThan(R * 0.99);
    expect(dist).toBeLessThan(R * 1.01);
    expect(Math.atan2(body.y, body.x)).toBeCloseTo(0.6, 3); // straight along the heading
    expect(jumpPhase(trace[jt.chargeTicks - 2], jt).phase).toBe('charging');
    expect(jumpPhase(trace[jt.chargeTicks - 1], jt).phase).toBe('burn');
    expect(jumpPhase(trace[total + 2], jt).phase).toBe('cooldown');
    const after = fly(total + CD + 2, () => true).trace;
    // trace[i] is the counter after i + 1 ticks: back to ready, and holding J restarts the charge
    expect(after[total + CD - 1]).toBe(0);
    expect(after[total + CD]).toBe(1);
  });

  it('a jump is a short burn whatever its length: a longer one just goes faster', () => {
    for (const d of [jt.minRange, 10000, R, 80000]) {
      expect(jumpDistance(jt, jumpScaleFor(d, jt, FRICTION)) + jumpCoast(jt, FRICTION)).toBeCloseTo(d, -2);
    }
    expect(jt.burnTicks).toBeLessThanOrEqual(90);
  });

  it('jumps as far as you aim (the cursor distance), within the shortest and longest the drive allows', () => {
    // (Where the ship comes to rest: after the burn, the coast)
    const go = (dist: number, boost = 1) => { const b = fly(jt.chargeTicks + jt.burnTicks + 600, (t) => t < jt.chargeTicks, 0.6, dist, boost).body; return Math.hypot(b.x, b.y); };
    expect(go(8000)).toBeGreaterThan(7950);
    expect(go(8000)).toBeLessThan(8050);
    expect(go(500)).toBeGreaterThan(jt.minRange * 0.95); // too short: the minimum
    expect(go(500000)).toBeLessThan(R * 1.05); // too far: the drive's reach
    // A star's charging ring stretches the reach
    expect(go(500000, jt.solarRangeBoost)).toBeGreaterThan(R * jt.solarRangeBoost * 0.97);
  });

  it('jump coils add reach and shorten the cooldown', () => {
    const plain = derive(sparrow());
    const bp = sparrow();
    const hull = bp.parts.find((q) => q.fn === 'hull' && q.piece === 'sq')!;
    hull.fn = 'jumpcoil';
    const coiled = derive(bp);
    expect(coiled.jumpRange).toBeGreaterThan(plain.jumpRange);
    expect(coiled.jumpCooldown).toBeLessThan(plain.jumpCooldown);
  });

  /**
   * Seconds to cover `dist` straight ahead from rest, boosting all the way
   * (with the batteries' accounting), or jumping whenever the drive is ready
   * and the mark is beyond its shortest jump, flying in between.
   */
  const travel = (b: Blueprint, dist: number, jump: boolean) => {
    const d = derive(b);
    const body: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0, jump: 0 };
    const cool = d.jumpCooldown || jt.cooldownTicks;
    let charge: Charge = { ...FULL_CHARGE }, prime = 0;
    for (let t = 0; t < 60 * 300; t++) {
      const left = dist - body.x;
      if (left <= 300) return t / 60;
      const ph = jumpPhase(body.jump ?? 0, { ...jt, cooldownTicks: cool }).phase;
      const spool = jump && (ph === 'charging' || (ph === 'ready' && left > jt.minRange));
      prime = pilotJumpStep(body, prime, NO_FIELDS, t, cool, jt, (rangeBoost) => {
        charge = stepShipPhysics(body, { forward: !spool, backward: false, left: false, right: false, boost: !spool, targetAngle: 0, helm: true, jump: spool, jumpDist: left },
          d, tuning, { charge, drainRate: 1 }, null, rangeBoost).charge;
      });
    }
    return Infinity;
  };

  it('beats flying on long legs; flying wins short hops', () => {
    const lancer = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/lancer.json'), 'utf-8'));
    for (const b of [sparrow(), withCoils(lancer, 12)]) {
      // A long trip: chaining jumps (flying while the drive recharges) is at least twice as quick
      for (const dist of [50000, 100000, 150000]) expect(travel(b, dist, true), `${b.name} ${dist}`).toBeLessThan(travel(b, dist, false) / 2);
      expect(travel(b, 20000, true), b.name).toBeLessThan(travel(b, 20000, false) / 2);
    }
    // A big hull on the core's coil alone: a poor drive, but still quicker than flying
    for (const dist of [50000, 150000]) expect(travel(lancer, dist, true), `${dist}`).toBeLessThan(travel(lancer, dist, false) * 0.8);
    // The starter ship hops a few thousand units quicker under its own power
    expect(travel(sparrow(), 6000, false)).toBeLessThan(travel(sparrow(), 6000, true));
  });

  /** A blueprint with its first `n` hull parts made jump coils (Mk I) */
  const withCoils = (b: Blueprint, n: number, material?: string) => {
    let k = 0;
    for (const q of b.parts) if (k < n && q.fn === 'hull') { q.fn = 'jumpcoil'; if (material) q.material = material; k++; }
    return b;
  };

  it('coils against the hull: the core alone serves a small ship generously, and the sweet spot gives ~50k and ~15 s', () => {
    // The core's own coil serves 40 cells: the starter has room to spare (a little more range, a quicker recharge)
    const s = derive(sparrow());
    expect(s.jumpRatio).toBeGreaterThan(2);
    expect(s.jumpRatio).toBeLessThan(4);
    expect(s.jumpRange).toBeGreaterThan(55000);
    expect(s.jumpRange).toBeLessThan(jt.baseRange * (1 + jt.overRangeMax));
    expect(s.jumpCooldown / 60).toBeGreaterThanOrEqual(10);
    expect(s.jumpCooldown / 60).toBeLessThan(13);
    const sweet = jumpDriveStats(100, 100, 1, jt);
    expect(sweet).toEqual({ range: jt.baseRange, cooldown: jt.cooldownTicks, ratio: 1 });
  });

  it('more coil than the hull needs helps less and less, and never makes a quick-fire jumper', () => {
    const at = (r: number, g = 1) => jumpDriveStats(r * 100, 100, g, jt);
    // Each doubling adds less range than the one before (or nothing, at the cap)
    let prev = at(1), gain = Infinity;
    for (const r of [2, 4, 8, 16]) {
      const now = at(r), g = now.range - prev.range;
      expect(g).toBeLessThanOrEqual(gain);
      expect(now.cooldown).toBeLessThanOrEqual(prev.cooldown);
      gain = g; prev = now;
    }
    expect(at(1000).range).toBeLessThanOrEqual(jt.baseRange * 1.4);
    for (const g of [1, 3, 5]) expect(at(1000, g).cooldown / 60).toBeGreaterThanOrEqual(10);
    // A starter loaded with coils: a little better, no more
    const piled = derive(withCoils(sparrow(), 7));
    expect(piled.jumpRatio).toBeGreaterThan(4);
    expect(piled.jumpRange).toBeLessThan(R * 1.4);
    expect(piled.jumpCooldown / 60).toBeGreaterThanOrEqual(10);
  });

  it('too little coil for the hull: less range and a slower recharge, smoothly, but still usable', () => {
    const at = (r: number) => jumpDriveStats(r * 100, 100, 1, jt);
    let prev = at(1);
    for (const r of [0.75, 0.5, 0.25, 0.1, 0.01, 0]) {
      const now = at(r);
      expect(now.range).toBeLessThanOrEqual(prev.range);
      expect(now.cooldown).toBeGreaterThanOrEqual(prev.cooldown);
      prev = now;
    }
    // Range never drops below ~30k (underRangeFloor), nor the recharge past ~25 s (underCooldownCap): a big hull short of coils is slower, still usable
    expect(Math.abs(at(0.5).range - 33000)).toBeLessThan(1500);
    expect(at(0.25).range).toBe(Math.round(jt.baseRange * jt.underRangeFloor));
    expect(Math.abs(at(0.5).cooldown / 60 - 24.4)).toBeLessThan(1);
    expect(at(0).range).toBeGreaterThanOrEqual(29000);
    expect(at(0).cooldown / 60).toBeLessThanOrEqual(25.01);
    // A big hull: coils bring it up to the sweet spot
    const lancer = () => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/lancer.json'), 'utf-8'));
    const bare = derive(lancer()), coiled = derive(withCoils(lancer(), 12));
    expect(bare.jumpRatio).toBeLessThan(0.6);
    expect(coiled.jumpRatio).toBeGreaterThan(1);
    expect(coiled.jumpRange).toBeGreaterThan(bare.jumpRange * 1.5);
    expect(coiled.jumpCooldown).toBeLessThan(bare.jumpCooldown * 0.6);
  });

  it('better coils give a slightly better sweet spot, and a little more capacity a cell', () => {
    const mk1 = jumpDriveStats(100, 100, 1, jt), mk5 = jumpDriveStats(100, 100, 5, jt);
    expect(mk5.range).toBeGreaterThan(mk1.range);
    expect(mk5.range).toBeLessThan(mk1.range * 1.3);
    expect(mk5.cooldown).toBeLessThan(mk1.cooldown);
    expect(mk5.cooldown).toBeGreaterThan(mk1.cooldown * 0.7);
    const lancer = () => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/lancer.json'), 'utf-8'));
    const plain = derive(withCoils(lancer(), 6)), fine = derive(withCoils(lancer(), 6, 'titanium'));
    expect(fine.jumpRatio).toBeGreaterThan(plain.jumpRatio);
    expect(fine.jumpRange).toBeGreaterThan(plain.jumpRange);
    expect(fine.jumpCooldown).toBeLessThan(plain.jumpCooldown);
  });

  it('letting go during the charge cancels it with no cooldown', () => {
    const { body, trace } = fly(jt.chargeTicks + 20, (t) => t < jt.chargeTicks / 2);
    expect(trace[trace.length - 1]).toBe(0);
    expect(Math.hypot(body.x, body.y)).toBeLessThan(1);
  });

  it('is deterministic through the quantised ship step', () => {
    const run = () => {
      const d = derive(sparrow());
      const body: FlightBody = { x: 100, y: -50, vx: 1, vy: 0, angle: 2, angVel: 0, jump: 0 };
      for (let t = 0; t < 200; t++) {
        stepShipPhysics(body, { forward: t % 3 === 0, backward: false, left: false, right: false, boost: false, targetAngle: 2.2, jump: t > 10 }, d, tuning, { fuel: 0, drainRate: 0 });
      }
      return body;
    };
    expect(run()).toEqual(run());
  });
});

// ---------------------------------------------------------------------------
describe('weapon balance: grades, sizes and the laser', () => {
  const MATS = ['alloy', 'steel', 'titanium', 'cobalt', 'neutronium'];
  const H: Record<string, number> = { sq: 1, rect2: 1, block2: 2, block3: 3 };
  /** A core, a generator and one gun out front */
  const gunship = (fn: string, piece: string, material: string, turret: boolean) => bp([
    p(0, 'rect2', 'core', 0, 0),
    p(1, piece, fn, 0, -H[piece], { material, facing: 'N', ...(turret ? { mount: 'turret' as const } : {}) }),
    p(2, 'rect2', 'generator', 0, 1),
  ]);
  /** One gun's damage per second at full power, its own tuning (grade and size) and its energy per second */
  const gun = (fn: string, piece: string, material: string, turret = true) => {
    const s = createShipState(catalog, tuning, 1, gunship(fn, piece, material, turret), 0);
    const w = s.derived.weapons[0];
    const def = partWeaponDef(tuning, w.kind, s.blueprint.parts[w.part], w);
    const dps = baseWeaponDps(tuning, w.kind, w.interval, def) * w.strength;
    const draw = def.type === 'beam' ? w.energy * 60 : (w.energy * 60) / w.interval;
    return { w, def, dps, draw };
  };

  it('every mark of cannon out-damages the one before, and for the power it takes too (short of power, a Mk II is no worse)', () => {
    for (const piece of ['sq', 'block2', 'block3']) for (const turret of [true, false]) {
      const g = MATS.map((m) => gun('weapon', piece, m, turret));
      for (let i = 1; i < g.length; i++) {
        expect(g[i].dps, `${piece} Mk ${i + 1}`).toBeGreaterThan(g[i - 1].dps);
        expect(g[i].dps / g[i].draw, `${piece} Mk ${i + 1} per power`).toBeGreaterThanOrEqual(g[i - 1].dps / g[i - 1].draw - 1e-9);
      }
    }
  });

  it('each mark of cannon has its own character, not just bigger numbers', () => {
    const [mk1, mk2, mk3, mk4, mk5] = MATS.map((m) => gun('weapon', 'block2', m));
    // Mk II: heavier shells, a little slower to load and to fly
    expect(mk2.def.damage!).toBeGreaterThan(mk1.def.damage!);
    expect(mk2.w.interval).toBeGreaterThan(mk1.w.interval);
    expect(mk2.def.speed!).toBeLessThan(mk1.def.speed!);
    // Mk III: fast, accurate slugs that reach further
    expect(mk3.def.speed!).toBeGreaterThan(mk1.def.speed! * 1.2);
    expect(mk3.def.spread!).toBeLessThan(mk1.def.spread!);
    expect(mk3.def.speed! * mk3.def.life!).toBeGreaterThan(mk1.def.speed! * mk1.def.life!);
    // Mk IV: a rapid autoloader; Mk V: siege slugs that punch through
    expect(mk4.w.interval).toBeLessThan(mk1.w.interval);
    expect(mk5.def.pierce ?? 0).toBeGreaterThan(0);
    expect(mk5.def.damage!).toBeGreaterThan(mk4.def.damage!);
  });

  it('the beam laser fires charged pulses: reach over 3200, no heat, and it keeps up with a fixed cannon', () => {
    const laser = gun('laser', 'sq', 'alloy');
    const cannon = gun('weapon', 'sq', 'alloy', false);
    expect(laser.def.range!).toBeGreaterThanOrEqual(3200);
    expect(laser.def.pulse).toBeDefined();
    expect(laser.def.heatPerSec).toBeUndefined();
    // It charges between pulses (its interval), longer than a pulse lasts
    const prof = pulseProfile(laser.def.pulse!);
    expect(laser.w.interval).toBeGreaterThan(prof.ticks);
    expect(laser.dps).toBeGreaterThan(cannon.dps * 0.9);
    // Better marks of laser: each better than the last
    const marks = MATS.map((m) => gun('laser', 'sq', m));
    for (let i = 1; i < marks.length; i++) expect(marks[i].dps).toBeGreaterThan(marks[i - 1].dps);
  });

  it('a fixed beam swings further on its gimbal than a fixed gun (no spread or fat shell to forgive it)', () => {
    const off = 6 * Math.PI / 180;
    const gun = stepFixedGunAim(off, tuning);
    const beam = stepFixedGunAim(off, tuning, off, true);
    expect(gun.offset).toBeLessThan(off);
    expect(beam.offset).toBeCloseTo(off, 9);
    expect(beam.canFire).toBe(true);
    // Past its gimbal it still holds fire
    expect(stepFixedGunAim(20 * Math.PI / 180, tuning, 20 * Math.PI / 180, true).canFire).toBe(false);
  });

  it('a laser burns at full strength to its effective range, then tails off steeply to its full range (half as far again), and no further', () => {
    const laser = gun('laser', 'sq', 'alloy');
    const def = laser.def;
    const eff = effectiveRange(def), max = def.range!;
    expect(eff).toBeCloseTo(3400, -1);
    expect(max).toBeCloseTo(eff * 1.5, -1);
    expect(beamFalloff(def, 100)).toBe(1);
    expect(beamFalloff(def, eff - 1)).toBe(1);
    // Steeply: well under half by a third of the way out, near the floor at the end
    expect(beamFalloff(def, eff + (max - eff) / 3)).toBeLessThan(0.55);
    expect(beamFalloff(def, max)).toBeGreaterThan(0.08);
    expect(beamFalloff(def, max)).toBeLessThan(0.16);
    for (let d = eff; d < max; d += 50) expect(beamFalloff(def, d + 50)).toBeLessThanOrEqual(beamFalloff(def, d));
    expect(beamFalloff(def, max + 10)).toBe(0);
    // A better grade's longer reach moves both
    const mk5 = gun('laser', 'sq', 'neutronium').def;
    expect(effectiveRange(mk5)).toBeGreaterThan(eff);
    // The part's tooltip shows both
    const st = partStats(catalog, tuning, { material: 'alloy', fn: 'laser', piece: 'sq' })!;
    expect(st.effectiveRange).toBeCloseTo(eff, 0);
    expect(st.range).toBeCloseTo(max, 0);
  });

  it('a pulse fades in from nothing, peaks for an instant at its widest and hardest, then trails off', () => {
    const def = tuning.weapons!.laser;
    const p = pulseProfile(def.pulse!);
    expect(p.ticks / 60).toBeGreaterThanOrEqual(0.6);
    expect(p.ticks / 60).toBeLessThanOrEqual(1.6);
    expect(p.share.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // Ramp: from nothing, rising, low and narrow
    expect(p.intensity[0]).toBeLessThan(0.05);
    for (let k = 1; k < p.peak; k++) expect(p.intensity[k]).toBeGreaterThanOrEqual(p.intensity[k - 1]);
    // Peak: the one brightest, widest, hardest tick, with a big share of the pulse
    for (let k = 0; k < p.ticks; k++) if (k !== p.peak) {
      expect(p.share[k]).toBeLessThan(p.share[p.peak]);
      expect(p.width[k]).toBeLessThan(p.width[p.peak]);
    }
    expect(p.share[p.peak]).toBeGreaterThan(0.3);
    expect(p.width[p.peak]).toBe(1);
    // Tail: falling back to (nearly) nothing
    for (let k = p.peak + 2; k < p.ticks; k++) expect(p.intensity[k]).toBeLessThanOrEqual(p.intensity[k - 1]);
    expect(p.intensity[p.ticks - 1]).toBeLessThan(0.05);
    expect(pulseIntensity(p, -1)).toBe(0);
    expect(pulseIntensity(p, p.ticks)).toBe(0);
  });

  it('a pulse laser charges like a gun reloads and starts a pulse when charged, held and paid for', () => {
    const b = sparrow();
    for (const q of b.parts) if (q.fn === 'cannon_pip') q.fn = 'laser_glint';
    const ship = createShipState(catalog, tuning, 1, b, 0);
    const pose = { x: 0, y: 0, angle: -Math.PI / 2 };
    let pulses = 0, beams = 0;
    const T = 60 * 6;
    for (let t = 1; t <= T; t++) {
      const r = stepGuns(ship, pose, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0 }, t, tuning);
      pulses += r.pulses.length; beams += r.beams.length;
      expect(r.shots).toHaveLength(0);
    }
    const w = ship.derived.weapons[0];
    expect(beams).toBe(0);
    // (The two take turns, half an interval apart: the second's last pulse falls after T)
    const n = ship.derived.weapons.length;
    let want = 0;
    for (let j = 0; j < n; j++) want += Math.floor((T - 1 - Math.ceil((j * w.interval) / n)) / w.interval) + 1;
    expect(pulses).toBe(want);
    expect(ship.overheated.some(Boolean)).toBe(false);
    // Each pulse is paid for at its start, as a shot is
    const dry = { charge: { g: 0, d: 0, w: 0 } as Charge };
    const fresh = createShipState(catalog, tuning, 2, b, 0);
    expect(stepGuns(fresh, pose, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy: dry }, 1, tuning).pulses).toHaveLength(0);
  });

  /** A core, a generator, four guns across the front (`fns` by slot), fired for `T` ticks: each gun's fire ticks */
  const ripple = (fns: string[], T: number) => {
    const b = bp([
      p(0, 'rect2', 'core', 0, 0),
      p(1, 'sq', fns[0], -1, 0, { facing: 'N' }),
      p(2, 'sq', fns[1], 0, -1, { facing: 'N' }),
      p(3, 'sq', fns[2], 1, -1, { facing: 'N' }),
      p(4, 'sq', fns[3], 2, 0, { facing: 'N' }),
      p(5, 'rect2', 'generator', 0, 1),
    ]);
    expect(codes(b)).toEqual([]);
    const ship = createShipState(catalog, tuning, 1, b, 0);
    const pose = { x: 0, y: 0, angle: -Math.PI / 2 };
    const at = new Map<number, number[]>();
    for (let t = 1; t <= T; t++) {
      const r = stepGuns(ship, pose, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0 }, t, tuning);
      for (const x of [...r.shots, ...r.pulses]) { if (!at.has(x.w.part)) at.set(x.w.part, []); at.get(x.w.part)!.push(t); }
    }
    return { ship, at };
  };

  it('a ship\'s lasers fire one by one, evenly over their charge, the first at once, as many pulses a minute as together', () => {
    const T = 60 * 60;
    const { ship, at } = ripple(['laser', 'laser', 'laser', 'laser'], T);
    const interval = ship.derived.weapons[0].interval;
    const all = [...at.values()].flat().sort((x, y) => x - y);
    // First pull: one fires on the first tick, not all four
    expect(all[0]).toBe(1);
    expect(all.filter((t) => t === 1)).toHaveLength(1);
    // Evenly spaced: interval / 4 apart (to the tick)
    for (let i = 1; i < all.length; i++) expect(Math.abs(all[i] - all[i - 1] - interval / 4)).toBeLessThanOrEqual(1);
    // The same pulses a minute as four firing together
    expect(all.length).toBeGreaterThanOrEqual(4 * Math.floor(T / interval));
    expect(all.length).toBeLessThanOrEqual(4 * Math.ceil(T / interval));
    for (const ticks of at.values()) for (let i = 1; i < ticks.length; i++) expect(Math.abs(ticks[i] - ticks[i - 1] - interval)).toBeLessThanOrEqual(1);
  });

  it('a cannon next to lasers keeps its own rate: kinds and intervals never ripple together', () => {
    const T = 60 * 30;
    const { ship, at } = ripple(['weapon', 'laser', 'laser', 'weapon'], T);
    const cannon = ship.derived.weapons.find((w) => w.kind === 'cannon')!;
    for (const w of ship.derived.weapons.filter((x) => x.kind === 'cannon')) {
      const ticks = at.get(w.part)!;
      expect(ticks[0]).toBe(1);
      expect(ticks.length).toBeGreaterThanOrEqual(Math.floor(T / cannon.interval));
    }
    // (Cannons don't ripple: both fire together)
    expect(at.get(1)![0]).toBe(at.get(4)![0]);
    // The lasers ripple between themselves
    const l = ship.derived.weapons.filter((x) => x.kind === 'laser').map((w) => at.get(w.part)![0]).sort((x, y) => x - y);
    expect(l[1] - l[0]).toBeCloseTo(ship.derived.weapons.find((x) => x.kind === 'laser')!.interval / 2, -0.5);
  });

  it('a bigger flak gun is better per gun: harder, wider bursts that reach further; per cell it loads a little slower', () => {
    const sizes = ['sq', 'rect2', 'block2', 'block3'].map((piece) => ({ piece, ...gun('flak', piece, 'alloy') }));
    for (let i = 1; i < sizes.length; i++) {
      const [a, b] = [sizes[i - 1], sizes[i]];
      expect(b.dps, b.piece).toBeGreaterThan(a.dps);
      expect(b.def.splash!.radius, b.piece).toBeGreaterThan(a.def.splash!.radius);
      expect(b.def.splash!.damage * b.w.strength, b.piece).toBeGreaterThan(a.def.splash!.damage * a.w.strength);
      expect(b.def.fuse!, b.piece).toBeGreaterThan(a.def.fuse!);
      expect(b.w.interval, b.piece).toBeGreaterThan(a.w.interval);
    }
    // A 2×2 burst lands on (radius / cell) parts: over 1.4× the panel's, each hit harder
    expect(sizes[2].def.splash!.radius / sizes[1].def.splash!.radius).toBeGreaterThan(1.2);
  });

  it('guns short of power take turns: a big gun isn\'t starved by small ones nibbling at the charge', () => {
    const b = bp([
      p(0, 'rect2', 'core', 0, 0),
      // (The small guns come first: paying in order, they'd take every bit as it came in)
      p(1, 'sq', 'weapon', -1, 0, { facing: 'N' }),
      p(2, 'sq', 'weapon', 2, 0, { facing: 'N' }),
      p(3, 'sq', 'generator', 0, 1),
      p(4, 'block2', 'weapon', 0, -2, { facing: 'N', mount: 'turret' }),
    ]);
    expect(codes(b)).toEqual([]);
    const ship = createShipState(catalog, tuning, 1, b, 0);
    // A damaged generator: it makes less than the two small guns alone would use
    ship.derived = derive(b, (max, i) => (i === 3 ? max * 0.2 : max));
    expect(ship.derived.energy.spare).toBeLessThan(2 * catalog.functions.get('weapon')!.demand!);
    const big = ship.derived.weapons.find((w) => w.part === 4)!;
    const pose = { x: 0, y: 0, angle: -Math.PI / 2 };
    // The battery empty, only a trickle coming in
    let charge: Charge = { g: 0, d: 0, w: 0 };
    const fired = new Map<number, number>();
    const T = 60 * 20;
    for (let t = 1; t <= T; t++) {
      charge = powerTick(ship.derived, charge, { thrusting: false, boosting: false }, tuning).charge;
      const energy = { charge };
      for (const s of stepGuns(ship, pose, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0, energy }, t, tuning).shots) fired.set(s.w.part, (fired.get(s.w.part) ?? 0) + 1);
      charge = energy.charge;
    }
    // Each gets its share of what came in, by what its shots cost (not first come, first served)
    const spent = [...fired].reduce((n, [part, k]) => n + k * ship.derived.weapons.find((w) => w.part === part)!.energy, 0);
    const bigShare = ((fired.get(4) ?? 0) * big.energy) / spent;
    expect(fired.get(4) ?? 0).toBeGreaterThan(0);
    expect(fired.get(1) ?? 0).toBeGreaterThan(0);
    expect(bigShare).toBeGreaterThan(0.3);
    // Short of power, a gun never fires faster than it loads
    expect(fired.get(4)!).toBeLessThanOrEqual(Math.ceil(T / big.interval));
  });

  it('a fixed gun\'s fractional interval averages out (it keeps the part of a tick it fired late by)', () => {
    // (Legacy Mk II cannons, as enemies fly: their heavy shells load in 17 and a bit ticks)
    const b = sparrow();
    for (const q of b.parts) if (q.fn === 'cannon_pip') Object.assign(q, { fn: 'weapon', material: 'steel' });
    const ship = createShipState(catalog, tuning, 1, b, 0);
    const w = ship.derived.weapons[0];
    expect(w.interval % 1).toBeGreaterThan(0.01);
    const pose = { x: 0, y: 0, angle: -Math.PI / 2 };
    let n = 0;
    for (let t = 1; t <= 6000; t++) n += stepGuns(ship, pose, { firing: true, aimWorld: -Math.PI / 2, aimDist: 0 }, t, tuning).shots.filter((s) => s.w.part === w.part).length;
    expect(n).toBeCloseTo(6000 / w.interval, -0.5);
  });
});
