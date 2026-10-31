/**
 * Cargo mass (load.ts): what's in the hold weighs the ship down, and the pilot's step, a replica and keyframes all fly
 * the same load. (These lived in anchor.test.ts until the Stabiliser Anchor was removed.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from './blueprint.js';
import { createShipState } from './state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';
import type { ShipTuning } from './tuning.js';
import type { ShipDerived } from './rebuild.js';
import type { FlightBody, FlightControls } from './flight.js';
import { stepShipPhysics } from './physics.js';
import { replicaStep, ReplicaMode, controlBits } from './replica.js';
import { cargoThrust, cargoTurn, cargoEffect, quantizeCargo } from './load.js';
import { FULL_CHARGE } from './energy.js';
import { packKeyframe, unpackKeyframe } from '../network/replication.js';
import { ItemCatalog, type ItemsFile } from '../econ/items.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');

const sparrow = () => createShipState(catalog, tuning, 1, parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8')), 0);
const NONE: FlightControls = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: 0 };
const body = (o: Partial<FlightBody> = {}): FlightBody => ({ x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0, jump: 0, ...o });
const fly = (b: FlightBody, d: ShipDerived, c: Partial<FlightControls>, ticks: number) => {
  for (let i = 0; i < ticks; i++) stepShipPhysics(b, { ...NONE, ...c }, d, tuning, { charge: FULL_CHARGE, drainRate: 0 });
  return b;
};

describe('cargo mass', () => {
  it('a full hold accelerates and turns slower; relative to the ship, so a big hauler minds it less', () => {
    const d = sparrow().derived;
    const empty = fly(body(), d, { forward: true }, 30);
    const full = fly(body({ cargo: 3 }), d, { forward: true }, 30);
    expect(full.vy).toBeLessThan(0);
    expect(Math.abs(full.vy)).toBeLessThan(Math.abs(empty.vy) * 0.9);
    expect(full.cargo).toBe(3);
    const turnE = fly(body(), d, { targetAngle: 2 }, 8), turnF = fly(body({ cargo: 3 }), d, { targetAngle: 2 }, 8);
    expect(Math.abs(turnF.angle)).toBeLessThan(Math.abs(turnE.angle));
    // The same load on a big hauler costs far less of its thrust
    const hauler = createShipState(catalog, tuning, 2, parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/hauler.json'), 'utf-8')), 0).derived;
    expect(1 - cargoThrust(hauler, 3)).toBeLessThan((1 - cargoThrust(d, 3)) / 5);
    expect(cargoTurn(d, 3)).toBeGreaterThan(cargoThrust(d, 3));
    expect(cargoEffect(d, 0)).toEqual({ mass: 0, thrustLoss: 0, turnLoss: 0 });
    expect(quantizeCargo(1.23456)).toBe(1.23);
  });

  it('item masses: ore heavy, gems light, ammunition between; storage is not the hold', () => {
    const items = new ItemCatalog(JSON.parse(readFileSync(join(SHIP_DATA_DIR, '../items.json'), 'utf-8')) as ItemsFile);
    expect(items.mass('iron_ore')).toBeGreaterThan(items.mass('railgun_slugs'));
    expect(items.mass('railgun_slugs')).toBeGreaterThan(items.mass('ruby'));
    expect(items.mass('neutronium_ore')).toBeGreaterThan(items.mass('iron_ore'));
    expect(items.massOf([{ id: 'iron_ore', n: 30 }])).toBeCloseTo(30 * items.mass('iron_ore'), 6);
  });
});

describe('prediction and replicas fly the same load', () => {
  it('the pilot step (controls) and a replica (bits) agree tick for tick with cargo', () => {
    const d = sparrow().derived;
    const env = { gravity: null, central: null, lodestones: [] };
    const server = body({ cargo: 2.5 }), replica = body({ cargo: 2.5 });
    const script = (t: number): Partial<FlightControls> => (t < 40 ? { forward: true, targetAngle: 0.7 } : t < 140 ? { targetAngle: 1.4 } : { right: true, targetAngle: -0.3 });
    for (let t = 0; t < 260; t++) {
      const c = { ...NONE, ...script(t) };
      stepShipPhysics(server, c, d, tuning, { charge: FULL_CHARGE, drainRate: 0 });
      replicaStep(ReplicaMode.Player, replica, { bits: controlBits(c), targetAngle: c.targetAngle }, d, tuning, env as never, t);
      expect(replica).toEqual(server);
    }
  });

  it('keyframes carry the cargo mass (and a dock after it); none of the tail when there is nothing to say', () => {
    const k = { id: 7, mode: ReplicaMode.Player, body: body({ x: 1, cargo: 3.4 }), ctl: { bits: 0, targetAngle: 0 }, q: 0 };
    expect(unpackKeyframe(packKeyframe(k)).body).toMatchObject({ cargo: 3.4 });
    const docked = unpackKeyframe(packKeyframe({ ...k, body: body(), dock: { station: 9, ox: 1, oy: 2 } }));
    expect(docked.dock).toEqual({ station: 9, ox: 1, oy: 2 });
    expect(docked.body.cargo).toBeUndefined();
    expect(packKeyframe({ ...k, body: body() }).length).toBe(12);
  });
});
