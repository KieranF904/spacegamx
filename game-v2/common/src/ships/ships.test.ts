import { describe, it, expect } from 'vitest';
import type { Blueprint, InventoryStub, PlacedPart, Rot, Side } from './types.js';
import { parseBlueprint, partFacingRule, partNeedsFacing, serializeBlueprint, validateBlueprint } from './blueprint.js';
import { rebuild, type ShipDerived } from './rebuild.js';
import { createShipState, damagePart, splitRebuild } from './state.js';
import { healthFactor, ShipTuning } from './tuning.js';
import { stepFlight, FlightBody, jumpTuning, jumpPhase, jumpDistance, jumpCoast, jumpScaleFor, jumpDriveStats, jumpChargeNeed, jumpBurnAt } from './flight.js';
import { pilotJumpStep, NO_FIELDS } from './jumpFields.js';
import { stepShipPhysics } from './physics.js';
import { FULL_CHARGE, type Charge } from './energy.js';
import { stepGuns } from './guns.js';
import { stepFixedGunAim } from './turret.js';
import { partWeaponDef } from './launch.js';
import { baseWeaponDps } from './rating.js';
import { pulseProfile, pulseIntensity, beamFalloff, effectiveRange } from './pulse.js';
import { partStats } from './partStats.js';
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
    it('a part joined to nothing is allowed (planned ahead) and reported as unreachable', () => {
      const b = sparrow();
      b.parts.push(p(20, 'sq', 'hull', 10, 10));
      expect(codes(b)).toEqual([]);
      const r = validateBlueprint(catalog, b, tuning);
      expect(r.ok).toBe(true);
      expect(r.unreachable).toEqual([20]);
      expect(validateBlueprint(catalog, sparrow(), tuning).unreachable).toEqual([]);
    });
    it('a planned part joined to nothing is never built: not alive, no mass, not shed as debris; joined, it stands', () => {
      const plain = createShipState(catalog, tuning, 1, sparrow(), 0);
      const b = sparrow();
      b.parts.push(p(20, 'sq', 'hull', 10, 10));
      const s = createShipState(catalog, tuning, 1, b, 0);
      const k = b.parts.length - 1;
      expect(s.derived.alive[k]).toBe(false);
      expect(s.derived.alive.slice(0, k).every(Boolean)).toBe(true);
      expect(s.derived.mass).toBeCloseTo(plain.derived.mass, 9);
      // (Even at full HP it stays put: a rebuild point doesn't break it off as a piece)
      expect(splitRebuild(s, catalog, tuning)).toEqual([]);
      expect(s.detached[k]).toBe(false);
      expect(s.derived.alive[k]).toBe(false);
      // Something joins it to the core's structure: it is built
      let joined: Blueprint | null = null;
      for (let x = -6; x <= 6 && !joined; x++) for (let y = -8; y <= 8 && !joined; y++) {
        const c = { ...sparrow(), parts: [...sparrow().parts, p(20, 'sq', 'hull', x, y)] };
        const v = validateBlueprint(catalog, c, tuning);
        if (v.ok && !v.unreachable.length) joined = c;
      }
      expect(joined).toBeTruthy();
      const j = createShipState(catalog, tuning, 1, joined!, 0);
      expect(j.derived.alive[joined!.parts.length - 1]).toBe(true);
      expect(j.derived.mass).toBeGreaterThan(plain.derived.mass);
    });
    it('facing edges free', () => {
      const b = sparrow();
      b.parts.push(p(20, 'sq', 'hull', 0, 2)); // right behind the engine at (0, 1)
      expect(codes(b)).toContain('facingBlocked');
    });
    it('a Diode\'s facing (its out side) must touch a part instead; a Conduit has none', () => {
      expect([partFacingRule('power_diode'), partFacingRule('power_conduit'), partFacingRule('cannon_pip')]).toEqual(['joined', null, 'free']);
      expect([partNeedsFacing('power_diode'), partNeedsFacing('power_conduit')]).toEqual([true, false]);
      const d = (facing?: Side) => bp([p(0, 'sq', 'core', 0, 0), p(1, 'sq', 'power_diode', 1, 0, facing ? { facing } : {}), p(2, 'sq', 'power_conduit', 2, 0)]);
      expect(codes(d('E'))).toEqual([]);
      expect(codes(d('W'))).toEqual([]);
      expect(codes(d('N'))).toEqual(['facingNotJoined']);
      expect(codes(d())).toEqual(['facingMissing']);
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
      b.parts.find((q) => q.uid === 9)!.fn = 'power_cell_reactor'; // a triangle can't be a Cell Reactor (a square model)
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
    // (A model's interval is its own: the Pip's 20 ticks, heavier-shots-2026-11; it was the legacy fixed guns' 15)
    expect(d.weapons.map((w) => w.interval)).toEqual([20, 20]);
  });

  it('removing a side thruster gives a lopsided turn', () => {
    const b = sparrow();
    b.parts = b.parts.filter((q) => q.uid !== 5); // left thruster
    const d = derive(b);
    expect(d.maxTorque.cw).toBeLessThan(d.maxTorque.ccw);

    // Fly it: it swings away quicker to the left (rest to rest the two even out: a turn speeds up on one side's thrust
    // and brakes on the other's), and either way it settles on the heading without overshooting
    const turn = (target: number) => {
      const body: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0 };
      let early = 0, over = 0;
      for (let t = 1; t <= 600; t++) {
        stepFlight(body, { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: target },
          d, tuning, { fuel: 0, drainRate: 0 }, K);
        if (t === 6) early = Math.abs(body.angle + Math.PI / 2);
        over = Math.max(over, (body.angle - target) * Math.sign(target + Math.PI / 2));
      }
      expect(body.angle).toBeCloseTo(target, 3);
      expect(over).toBeLessThan(0.005);
      return early;
    };
    const right = turn(-Math.PI / 2 + 1.5);
    const left = turn(-Math.PI / 2 - 1.5);
    expect(right).toBeLessThan(left);
  });
});

// ---------------------------------------------------------------------------
describe('power figures (M4)', () => {
  it('generator output follows the health curve', () => {
    const b = sparrow(), gi = b.parts.findIndex((q) => q.fn === 'power_cell_reactor');
    const PRODUCE = catalog.functions.get('power_cell_reactor')!.produce!;
    const whole = derive(b).energy.supply;
    // (The starter's two Cell Reactors: one at half health)
    expect(whole).toBeCloseTo(2 * PRODUCE, 9);
    expect(derive(b, (max, i) => (i === gi ? max * 0.5 : max)).energy.supply).toBeCloseTo(PRODUCE * healthFactor(0.5, tuning) + PRODUCE, 9);
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
describe('library ships', () => {
  const PREMADE = ['bulwark', 'sunspear', 'hauler'];

  it.each(PREMADE)('%s is valid with the inventory and can fly', (file) => {
    const b = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, `blueprints/${file}.json`), 'utf-8'));
    expect(validateBlueprint(catalog, b, tuning, inventory).errors).toEqual([]);
    const d = derive(b);
    expect(d.alive.every(Boolean)).toBe(true);
    expect(d.maxThrust.forward / d.mass).toBeGreaterThan(0.06);
  });

  it('heavier ships are slower', () => {
    const accel = (f: string) => {
      const d = derive(parseBlueprint(readFileSync(join(SHIP_DATA_DIR, `blueprints/${f}.json`), 'utf-8')));
      return d.maxThrust.forward / d.mass;
    };
    expect(accel('sparrow-t')).toBeGreaterThan(accel('bulwark'));
    expect(accel('bulwark')).toBeGreaterThan(accel('quarry'));
  });
});

// ---------------------------------------------------------------------------
describe('jump drive', () => {
  const jt = jumpTuning(tuning);
  /** The starter's own drive: its reach and cooldown (its core's coil against its hull) */
  const { jumpRange: R, jumpCooldown: CD } = derive(sparrow());
  const fly = (ticks: number, jump: (t: number) => boolean, angle = 0.6, jumpDist: number | ((t: number) => number) = 0, jumpBoost = 1, bp = sparrow()) => {
    const d = derive(bp);
    const body: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle, angVel: 0, jump: 0 };
    const trace: number[] = [];
    for (let t = 0; t < ticks; t++) {
      stepFlight(body, { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: angle, jump: jump(t), jumpDist: typeof jumpDist === "function" ? jumpDist(t) : jumpDist }, d, tuning, { fuel: 0, drainRate: 0 }, { ...K, jumpBoost });
      trace.push(body.jump!);
    }
    return { body, trace };
  };

  it('charges, then flies as far as the drive reaches along the nose, then cools down and is ready again', () => {
    const total = jt.chargeTicks + jt.burnTicks;
    // The burn ends dead still (exitSpeed 0), right on the mark: no coast for input or a gravity well to push about
    const burnt = fly(total - 1, () => true).body; // (its last burn tick)
    expect(jt.exitSpeed).toBe(0);
    expect(Math.hypot(burnt.vx, burnt.vy)).toBe(0);
    expect(Math.hypot(burnt.x, burnt.y)).toBeCloseTo(R, -2);
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
    for (const d of [500, 5000, 10000, R, 80000]) {
      expect(jumpDistance(jt, jumpScaleFor(d, jt, FRICTION)) + jumpCoast(jt, FRICTION)).toBeCloseTo(d, -2);
    }
    expect(jt.burnTicks).toBeLessThanOrEqual(90);
  });

  it('jumps as far as you aim (the cursor distance), however short, up to the longest the drive allows', () => {
    // (Where the ship comes to rest: after the burn, the coast)
    // (Held for as long as the jump charges: the same for every jump, jumpChargeNeed)
    const go = (dist: number, boost = 1) => {
      const need = jt.chargeTicks;
      const b = fly(need + jt.burnTicks + 600, (t) => t < need, 0.6, dist, boost).body;
      return Math.hypot(b.x, b.y);
    };
    expect(go(8000)).toBeGreaterThan(7950);
    expect(go(8000)).toBeLessThan(8050);
    // (No shortest jump, Kieran 2026-11-06: a hop goes a hop, to the burn scale's step, 0.001, about 27 units)
    for (const d of [4, 500, 2000]) expect(Math.abs(go(d) - d), String(d)).toBeLessThan(30);
    expect(go(500000)).toBeLessThan(R * 1.05); // too far: the drive's reach
    // A star's charging ring stretches the reach
    expect(go(500000, jt.solarRangeBoost)).toBeGreaterThan(R * jt.solarRangeBoost * 0.97);
  });

  it('jump coils add reach and shorten the cooldown', () => {
    // (A remake whose coils are fed, against the same hull with plain hull in their place: jumpCoils.test.ts has the feed rule)
    const remake = () => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/remakes/player-xire-sparrow.json'), 'utf-8'));
    const coiled = derive(remake());
    const bare = remake();
    for (const q of bare.parts) if (/coil/.test(q.fn)) q.fn = 'hull';
    const plain = derive(bare);
    expect(coiled.jumpRange).toBeGreaterThan(plain.jumpRange);
    expect(coiled.jumpCooldown).toBeLessThanOrEqual(plain.jumpCooldown);
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
      // (The pilot's choice: jump what's left past 5k, fly the rest)
      const spool = jump && (ph === 'charging' || (ph === 'ready' && left > 5000));
      prime = pilotJumpStep(body, prime, NO_FIELDS, t, cool, jt, (rangeBoost) => {
        charge = stepShipPhysics(body, { forward: !spool, backward: false, left: false, right: false, boost: !spool, targetAngle: 0, helm: true, jump: spool, jumpDist: left },
          d, tuning, { charge, drainRate: 1 }, null, rangeBoost).charge;
      });
    }
    return Infinity;
  };

  it('beats flying on long legs; flying keeps up on the shortest hop', () => {
    const lancer = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sunspear.json'), 'utf-8'));
    for (const b of [sparrow()]) {
      // A long trip: chaining jumps (flying while the drive recharges) is at least twice as quick
      for (const dist of [50000, 100000, 150000]) expect(travel(b, dist, true), `${b.name} ${dist}`).toBeLessThan(travel(b, dist, false) / 2);
      // A middling one: still well ahead
      expect(travel(b, 20000, true), b.name).toBeLessThan(travel(b, 20000, false) * 0.75);
    }
    // A big hull on the core's coil alone: a poor drive, but still quicker than flying
    for (const dist of [50000, 150000]) expect(travel(lancer, dist, true), `${dist}`).toBeLessThan(travel(lancer, dist, false) * 0.8);
    // A short hop (the shortest jump): about as quick either way, the 3 s charge and the burn against the starter boosting
    expect(Math.abs(travel(sparrow(), 5000, true) - travel(sparrow(), 5000, false))).toBeLessThan(2);
  });

  it('every jump charges the same 3 s, however far it is aimed (and whatever coils or fields it has): the reach decides how far, never how long', () => {
    // (Kieran, 2026-11-06: "the jump should just take about 3 seconds to charge, for any distance")
    expect(jt.chargeTicks).toBe(180);
    for (const d of [0, 4, 500, 5000, 6000, 8000, 12000, 20000, 25000, R, 80000, 200000]) expect(jumpChargeNeed(d, jt), String(d)).toBe(jt.chargeTicks);
    expect(jumpBurnAt(jt)).toBe(jt.chargeTicks);
    // Not known (a replica's): it never starts the burn itself
    expect(jumpChargeNeed(-1, jt)).toBe(Infinity);
    // Flown: the burn starts on the same tick for a short jump, a long one and one aimed past the reach, boosted or not
    for (const [dist, boost] of [[6000, 1], [20000, 1], [40000, 1], [500000, 1], [20000, jt.solarRangeBoost]] as const) {
      const { trace } = fly(jt.chargeTicks + 5, () => true, 0.6, dist, boost);
      expect(jumpPhase(trace[jt.chargeTicks - 2], jt).phase, String(dist)).toBe('charging');
      expect(jumpPhase(trace[jt.chargeTicks - 1], jt).phase, String(dist)).toBe('burn');
      expect(jumpPhase(trace[(jt.chargeTicks >> 1) - 1], jt).progress).toBeCloseTo(0.5, 1);
    }
    // The aim moving while it charges (the cursor's distance changing every tick): the charge is still 3 s
    const moving = fly(jt.chargeTicks + 5, () => true, 0.6, (t: number) => 6000 + ((t * 977) % 40000));
    expect(jumpPhase(moving.trace[jt.chargeTicks - 2], jt).phase).toBe('charging');
    expect(jumpPhase(moving.trace[jt.chargeTicks - 1], jt).phase).toBe('burn');
  });

  it('flies a jump once it has charged, and a charge let go part way collapses', () => {
    const j = fly(jt.chargeTicks + jt.burnTicks + 10, () => true, 0.6, 6000);
    expect(Math.hypot(j.body.x, j.body.y)).toBeCloseTo(6000, -2);
    const gone = fly(jt.chargeTicks + 50, (t) => t < jt.chargeTicks - 20, 0.6, 6000);
    expect(Math.hypot(gone.body.x, gone.body.y)).toBeLessThan(1);
  });

  it('coils against the hull: the core alone serves a small ship generously, and the sweet spot gives ~50k and ~15 s', () => {
    // The core's own coil serves 40 cells: the starter has room to spare (a little more range, a quicker recharge)
    const s = derive(sparrow());
    expect(s.jumpRatio).toBeGreaterThan(2);
    expect(s.jumpRatio).toBeLessThan(4);
    expect(s.jumpRange).toBeGreaterThan(55000);
    expect(s.jumpRange).toBeLessThan(jt.baseRange * (1 + 2 * jt.overRange));
    expect(s.jumpCooldown / 60).toBeGreaterThanOrEqual(10);
    expect(s.jumpCooldown / 60).toBeLessThan(13);
    const sweet = jumpDriveStats(100, 100, 1, jt);
    expect(sweet).toEqual({ range: jt.baseRange, cooldown: jt.cooldownTicks, ratio: 1 });
  });

  it('more coil than the hull needs helps less and less, and never makes a quick-fire jumper', () => {
    const at = (r: number, g = 1) => jumpDriveStats(r * 100, 100, g, jt);
    // Each doubling adds less range than the one before (no cap: diminishing returns, Kieran 2026-11-06)
    let prev = at(1), gain = Infinity;
    for (const r of [2, 4, 8, 16]) {
      const now = at(r), g = now.range - prev.range;
      expect(g).toBeGreaterThan(0);
      expect(g).toBeLessThanOrEqual(gain);
      expect(now.cooldown).toBeLessThanOrEqual(prev.cooldown);
      gain = g; prev = now;
    }
    expect(at(16).range).toBeLessThanOrEqual(jt.baseRange * 1.5);
    for (const g of [1, 3, 5]) expect(at(1000, g).cooldown / 60).toBeGreaterThanOrEqual(10);
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
    // A big hull on the core's coil alone is short of coil
    expect(derive(parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sunspear.json'), 'utf-8'))).jumpRatio).toBeLessThan(0.6);
  });

  it('better coils give a slightly better sweet spot, and a little more capacity a cell', () => {
    const mk1 = jumpDriveStats(100, 100, 1, jt), mk5 = jumpDriveStats(100, 100, 5, jt);
    expect(mk5.range).toBeGreaterThan(mk1.range);
    expect(mk5.range).toBeLessThan(mk1.range * 1.3);
    expect(mk5.cooldown).toBeLessThan(mk1.cooldown);
    expect(mk5.cooldown).toBeGreaterThan(mk1.cooldown * 0.7);
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
    expect((laser.def as Record<string, unknown>).heatPerSec).toBeUndefined();
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

  it('a weapon kind with its own gimbal (the Lance: tuning.json weapons.lance.gimbalDeg) swings that far, further than other fixed beams', () => {
    const D = Math.PI / 180, own = tuning.weapons?.lance?.gimbalDeg;
    expect(own).toBeGreaterThan(tuning.fixedGun!.beamGimbalDeg!);
    const off = (tuning.fixedGun!.beamGimbalDeg! + 3) * D;
    const beam = stepFixedGunAim(off, tuning, off, true);
    const lance = stepFixedGunAim(off, tuning, off, true, own);
    expect(beam.offset).toBeCloseTo(tuning.fixedGun!.beamGimbalDeg! * D, 9);
    expect(lance.offset).toBeCloseTo(off, 9);
    expect(lance.canFire).toBe(true);
    // Clamped at its own reach, either side
    expect(stepFixedGunAim(-40 * D, tuning, -40 * D, true, own).offset).toBeCloseTo(-own! * D, 9);
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
    expect(Object.keys(ship)).not.toContain('overheated');
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
