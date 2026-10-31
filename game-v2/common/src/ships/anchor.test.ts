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
import { replicaStep, ReplicaMode, controlBits, CTL } from './replica.js';
import { DEFAULT_ANCHOR, bracePhase, canBrace, isBraced, stepBrace, braceAmount, gunReach } from './anchor.js';
import { cargoThrust, cargoTurn, cargoEffect, quantizeCargo } from './load.js';
import { gunDef, launchShot } from './launch.js';
import { jumpPhase, jumpTuning } from './flight.js';
import { packKeyframe, unpackKeyframe } from '../network/replication.js';
import { ItemCatalog, type ItemsFile } from '../econ/items.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const FULL = { g: 100, d: 100, w: 100 };
const A = DEFAULT_ANCHOR;

const sparrow = (extra: object[] = []) => {
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
  bp.parts.push(...(extra as never[]));
  return createShipState(catalog, tuning, 1, bp, 0);
};
/** The Sparrow with a Stabiliser Anchor bolted on its right flank */
const ANCHOR_PART = { uid: 50, piece: 'block2', fn: 'utility_stabiliser_anchor', material: 'steel', x: 3, y: -1, rot: 0, flip: false };
const NONE: FlightControls = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: 0 };
const body = (o: Partial<FlightBody> = {}): FlightBody => ({ x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0, jump: 0, ...o });
const fly = (b: FlightBody, d: ShipDerived, c: Partial<FlightControls>, ticks: number) => {
  for (let i = 0; i < ticks; i++) stepShipPhysics(b, { ...NONE, ...c }, d, tuning, { charge: FULL, drainRate: 0 });
  return b;
};
/** A derived with a working anchor (the flight only reads `anchor`) */
const anchored = (d: ShipDerived): ShipDerived => ({ ...d, anchor: 1 });

describe('Stabiliser Anchor: the part', () => {
  it('is a data-driven model at level 18, a steady consumer, and gives a ship its brace once powered', () => {
    const fn = catalog.functions.get('utility_stabiliser_anchor')!;
    expect(fn.anchor).toBe(true);
    expect(fn.unlock?.level).toBeGreaterThanOrEqual(16);
    expect(fn.unlock?.level).toBeLessThanOrEqual(23);
    expect(fn.demand).toBeGreaterThan(0);
    const plain = sparrow().derived;
    expect(plain.anchor ?? 0).toBe(0);
    expect(canBrace(plain)).toBe(false);
    const d = sparrow([ANCHOR_PART]).derived;
    expect(d.anchor).toBeGreaterThanOrEqual(0.5);
    expect(canBrace(d)).toBe(true);
  });
});

describe('Stabiliser Anchor: bracing', () => {
  it('spools in over braceTicks, holds while wanted, and lets go over releaseTicks (committed)', () => {
    let c = 0;
    for (let i = 0; i < A.braceTicks; i++) c = stepBrace(c, true, true, A);
    expect(c).toBe(A.braceTicks);
    expect(bracePhase(c, A).phase).toBe('braced');
    expect(isBraced(c, A)).toBe(true);
    for (let i = 0; i < 100; i++) c = stepBrace(c, true, true, A);
    expect(isBraced(c, A)).toBe(true);
    // Let go: it releases, and can't be re-braced mid-way
    c = stepBrace(c, false, true, A);
    expect(bracePhase(c, A).phase).toBe('releasing');
    let ticks = 1;
    while (c !== 0) { c = stepBrace(c, true, true, A); ticks++; }
    expect(ticks).toBe(A.releaseTicks);
    // Abandoning a brace half-way counts back down; losing the anchor collapses it
    c = 0;
    for (let i = 0; i < 10; i++) c = stepBrace(c, true, true, A);
    c = stepBrace(c, false, true, A);
    expect(c).toBe(9);
    expect(stepBrace(c, true, false, A)).toBe(0);
    expect(stepBrace(A.braceTicks, true, false, A)).toBe(A.braceTicks + 1);
    expect(braceAmount(A.braceTicks, A)).toBe(1);
    expect(braceAmount(0, A)).toBe(0);
  });

  it('needs a working anchor: without one the control does nothing', () => {
    const d = sparrow().derived;
    const b = fly(body(), d, { brace: true, forward: true }, 60);
    expect(b.brace ?? 0).toBe(0);
    expect(b.vy).toBeLessThan(-0.5);
  });

  it('no thrust from the first spool tick; holds position braced; thrust only once fully released', () => {
    const d = anchored(sparrow().derived);
    // Coasting in, then braced: it stops far shorter than coasting
    const coast = fly(body({ vy: -6 }), d, {}, 120);
    const braced = fly(body({ vy: -6 }), d, { brace: true, forward: true }, 120);
    expect(braced.brace).toBe(A.braceTicks);
    expect(Math.abs(braced.vy)).toBeLessThan(0.01);
    expect(Math.abs(braced.y)).toBeLessThan(Math.abs(coast.y) * 0.6);
    // Released while thrusting: still now, moving again only after releaseTicks
    const b = body({ brace: A.braceTicks });
    fly(b, d, { forward: true }, A.releaseTicks - 1);
    expect(bracePhase(b.brace, A).phase).toBe('releasing');
    expect(Math.abs(b.vy)).toBeLessThan(1e-6);
    fly(b, d, { forward: true }, 2);
    expect(b.brace ?? 0).toBe(0);
    expect(b.vy).toBeLessThan(0);
  });

  it('turns slower while out, and no jump starts while braced (nor a brace mid-jump)', () => {
    const d = anchored(sparrow().derived);
    const free = fly(body(), d, { targetAngle: 2 }, 10);
    const out = fly(body({ brace: A.braceTicks }), d, { targetAngle: 2, brace: true }, 10);
    expect(Math.abs(out.angle)).toBeLessThan(Math.abs(free.angle));
    const jt = jumpTuning(tuning);
    const b = fly(body({ brace: A.braceTicks }), d, { brace: true, jump: true }, 30);
    expect(jumpPhase(b.jump ?? 0, jt).phase).toBe('ready');
    const j = fly(body({ jump: 10 }), d, { brace: true, jump: true }, 1);
    expect(j.brace ?? 0).toBe(0);
  });

  it('braced guns reach further and scatter less; the same shell on every side', () => {
    const plain = gunDef(tuning, 'cannon', {});
    const steady = gunDef(tuning, 'cannon', { braced: true });
    expect(gunReach(steady) / gunReach(plain)).toBeCloseTo(1 + A.range, 6);
    expect(gunDef(tuning, 'cannon', { braced: true })).toBe(steady);
    const shape = { speedScale: 1, sizeScale: 1, turret: false };
    const a = launchShot(plain, 'cannon', shape, 0, 0, 0, 100, 'x'), b = launchShot(steady, 'cannon', shape, 0, 0, 0, 100, 'x');
    expect(b.life).toBe(Math.round(a.life * (1 + A.range)));
    // The same seed: the braced shell strays half as far off the aim
    expect(Math.abs(Math.atan2(b.vy, b.vx))).toBeCloseTo(Math.abs(Math.atan2(a.vy, a.vx)) * (1 - A.spread), 6);
    const laser = gunDef(tuning, 'laser', { braced: true });
    expect(gunReach(laser)).toBeCloseTo((tuning.weapons!.laser.range ?? 800) * (1 + A.range), 6);
  });
});

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

describe('prediction and replicas fly the same load and brace', () => {
  it('the pilot step (controls) and a replica (bits) agree tick for tick, through a brace and with cargo', () => {
    const d = anchored(sparrow().derived);
    const env = { gravity: null, central: null, lodestones: [] };
    const server = body({ cargo: 2.5 }), replica = body({ cargo: 2.5 });
    const script = (t: number): Partial<FlightControls> => (t < 40 ? { forward: true, targetAngle: 0.7 } : t < 140 ? { brace: true, targetAngle: 1.4 } : { right: true, targetAngle: -0.3 });
    for (let t = 0; t < 260; t++) {
      const c = { ...NONE, ...script(t) };
      stepShipPhysics(server, c, d, tuning, { charge: FULL, drainRate: 0 });
      replicaStep(ReplicaMode.Player, replica, { bits: controlBits(c), targetAngle: c.targetAngle }, d, tuning, env, t);
      expect(replica).toEqual(server);
    }
    expect(controlBits({ brace: true }) & CTL.brace).toBe(CTL.brace);
  });

  it('keyframes carry the anchor counter and the cargo mass (and a dock after them)', () => {
    const k = { id: 7, mode: ReplicaMode.Player, body: body({ x: 1, brace: 12, cargo: 3.4 }), ctl: { bits: CTL.brace, targetAngle: 0 }, q: 0 };
    expect(unpackKeyframe(packKeyframe(k)).body).toMatchObject({ brace: 12, cargo: 3.4 });
    const docked = unpackKeyframe(packKeyframe({ ...k, body: body(), dock: { station: 9, ox: 1, oy: 2 } }));
    expect(docked.dock).toEqual({ station: 9, ox: 1, oy: 2 });
    expect(docked.body.brace).toBeUndefined();
    expect(packKeyframe({ ...k, body: body() }).length).toBe(12);
  });
});
