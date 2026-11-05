/**
 * The Gyro and Heavy Gyro (features/gyro): torque anywhere on the hull, both ways, no push; power only while turning,
 * in proportion; short of power, that much less turn.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../../blueprint.js';
import { createShipState } from '../../state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../testData.js';
import type { ShipTuning } from '../../tuning.js';
import type { ShipDerived } from '../../rebuild.js';
import type { FlightBody, FlightControls } from '../../flight.js';
import { turnAccel, wrapAngle } from '../../flight.js';
import { stepShipPhysics } from '../../physics.js';
import { FULL_CHARGE, type Charge } from '../../energy.js';
import { gyroDraw, gyroLoad, gyroUse } from './gyro.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const GYRO = (x: number, y: number, uid = 60) => ({ uid, piece: 'sq', fn: 'utility_gyro', material: 'alloy', x, y, rot: 0, flip: false });
const HEAVY = (x: number, y: number, uid = 61) => ({ uid, piece: 'block2', fn: 'utility_heavy_gyro', material: 'titanium', x, y, rot: 0, flip: false });
const ship = (extra: object[] = []): ShipDerived => {
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/fixtures/sparrow-t.json'), 'utf-8'));
  bp.parts.push(...(extra as never[]));
  return createShipState(catalog, tuning, 1, bp, 0).derived;
};
const NONE: FlightControls = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: 0 };
const body = (): FlightBody => ({ x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0, jump: 0 });

describe('gyro: torque', () => {
  it('adds its torque to both turning caps, on top of the core and the thrusters, and pushes nothing', () => {
    const d = ship([HEAVY(-3, -1)]);
    expect(d.fx?.gyro?.torque).toBe(28000);
    let cw = 0, ccw = 0;
    for (const t of d.thrusters) if (t.torque > 0) cw += t.torque; else ccw -= t.torque;
    const g = tuning.flight.thrusterTorqueGain;
    expect(d.maxTorque.cw).toBeCloseTo(tuning.flight.gyroTorque + 28000 + g * cw, 6);
    expect(d.maxTorque.ccw).toBeCloseTo(tuning.flight.gyroTorque + 28000 + g * ccw, 6);
    // Not a thruster: no force of its own
    expect(d.thrusters.some((t) => d.fx!.gyro!.parts.includes(t.part))).toBe(false);
  });

  it('gives the same torque wherever it sits; costs mass', () => {
    const a = ship([GYRO(3, 0)]), b = ship([GYRO(-2, 0)]), none = ship();
    expect(a.fx?.gyro?.torque).toBe(250);
    expect(b.fx?.gyro?.torque).toBe(250);
    expect(a.mass).toBeCloseTo(none.mass + 1.5, 6);
    expect(none.fx?.gyro).toBeUndefined();
  });

  it('swings a dreadnought onto a new heading sooner: two Heavy Gyros, a 90 degree turn settles over a fifth sooner, four over a third', () => {
    const settle = (d: ShipDerived) => {
      const b = body();
      let last = -1;
      for (let t = 0; t < 600; t++) {
        stepShipPhysics(b, { ...NONE, targetAngle: Math.PI / 2 }, d, tuning, { charge: FULL_CHARGE, drainRate: 0 });
        const ok = Math.abs(wrapAngle(Math.PI / 2 - b.angle)) < 0.02 && Math.abs(b.angVel) < 0.002;
        if (!ok) last = -1; else if (last < 0) last = t + 1;
      }
      return last;
    };
    const dread = (at: [number, number][]) => {
      const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/fixtures/bastion.json'), 'utf-8'));
      at.forEach(([x, y], k) => bp.parts.push(HEAVY(x, y, 240 + k) as never));
      const d = createShipState(catalog, tuning, 1, bp, 0).derived;
      expect(d.fx?.gyro?.parts.length ?? 0).toBe(at.length);
      return d;
    };
    const t0 = settle(dread([])), t2 = settle(dread([[-2, -2], [0, -2]])), t4 = settle(dread([[-2, -2], [0, -2], [2, -2], [2, 0]]));
    expect(t0).toBeGreaterThan(0);
    expect(t2).toBeLessThan(t0 * 0.8);
    expect(t4).toBeLessThan(t0 * 0.67);
    expect(turnAccel(dread([[-2, -2]])).cw).toBeGreaterThan(turnAccel(dread([])).cw);
  });
});

describe('gyro: power', () => {
  it('asks power only for the share of its torque a turn uses, from its feed group', () => {
    const d = ship([HEAVY(-3, -1)]), L = d.power!;
    const p = d.fx!.gyro!.parts[0];
    expect(L.feedOf[p]).toBeGreaterThanOrEqual(0);
    expect(gyroDraw(d)).toBeCloseTo(48, 6);
    expect(gyroLoad(d, 0)).toBeUndefined();
    const half = [...gyroLoad(d, 0.5)!];
    expect(half[L.feedOf[p]]).toBeCloseTo(24, 6);
    expect(half.reduce((s, v) => s + v, 0)).toBeCloseTo(24, 6);
    // A turn at the cap uses all of it; a gentle one a share; none holding a heading
    const cap = d.maxTorque.cw * 0.001;
    expect(gyroUse(d, cap, 0.001)).toBeCloseTo(1, 9);
    expect(gyroUse(d, cap / 4, 0.001)).toBeCloseTo(0.25, 9);
    expect(gyroUse(d, 0, 0.001)).toBe(0);
  });

  it('draws nothing holding a heading, and the turn is paid for out of the charge', () => {
    const d = ship([HEAVY(-3, -1), HEAVY(3, -1, 62)]);
    const run = (target: number) => {
      const b = body();
      let charge: Charge = { g: 30, b: [] };
      for (let t = 0; t < 20; t++) charge = stepShipPhysics(b, { ...NONE, targetAngle: target }, d, tuning, { charge, drainRate: 1 }).charge;
      return charge.g;
    };
    const still = run(0), turning = run(Math.PI / 2);
    expect(turning).toBeLessThan(still);
  });

  it('short of power, turns that much slower (the unpaid share of the turn is taken back)', () => {
    // (The Monarch with its generators swapped for hull and a Heavy Gyro run off a Drive Cell touching it; every store empty)
    const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/dev/review-monarch.json'), 'utf-8'));
    for (const p of bp.parts) if ((catalog.functions.get(p.fn)?.produce ?? 0) > 0) { p.fn = 'hull'; p.material = 'titanium'; }
    bp.parts.push(HEAVY(-4, 4, 240) as never, { uid: 241, piece: 'sq', fn: 'power_drive_cell', material: 'steel', x: -4, y: 6, rot: 0, flip: false } as never);
    const d = createShipState(catalog, tuning, 1, bp, 0).derived;
    expect(d.fx?.gyro?.torque).toBe(28000);
    expect(d.energy?.supply).toBe(0);
    const empty = (): Charge => ({ g: 0, b: d.power!.banks.map(() => 0) });
    const fly = (accounted: boolean, ticks: number) => {
      const b = body();
      let charge = empty();
      for (let t = 0; t < ticks; t++) charge = stepShipPhysics(b, { ...NONE, targetAngle: Math.PI / 2 }, d, tuning, { charge, drainRate: accounted ? 1 : 0 }).charge;
      return b;
    };
    // Unpowered, only the core's and the engines' torque turns it: the gyro's share of each tick's turn is taken back
    const free = fly(false, 1), starved = fly(true, 1);
    expect(starved.angVel).toBeGreaterThan(0);
    expect(starved.angVel).toBeCloseTo(free.angVel * (1 - 28000 / d.maxTorque.cw), 6);
    expect(starved.angle).toBeCloseTo(starved.angVel, 5);
    expect(fly(true, 10).angle).toBeLessThan(fly(false, 10).angle * 0.5);
  });
});
