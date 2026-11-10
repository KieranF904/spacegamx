/**
 * Burst Strafers, Gyros and shields on the ports core (Kieran, 2026-11-06: "The strafe thruster should require power like
 * all other thrusters, as should shields and gyros"). A strafer and a gyro are thrusters (TK_STRAFER, TK_GYRO) with their
 * own buffers filled over their in ports; they burn only while their feature asks (a burst, a turn, in proportion), and
 * push or turn by the share of it they got. A shield draws as a tool, and refills by its fulfilment (energy.ts shieldShare).
 */

import { describe, it, expect } from 'vitest';
import type { Blueprint, PlacedPart, Rot, Side } from '../types.js';
import { createShipState } from '../state.js';
import { stepShipPhysics } from '../physics.js';
import { controlBits } from '../replica.js';
import { worldToLocalDir, type FlightBody, type FlightControls } from '../flight.js';
import { FULL_CHARGE, fullPortsCharge, shieldShare, type Charge } from '../energy.js';
import { dodgeAffordable, burstEnergy, DODGE_LEFT } from '../features/strafer/strafer.js';
import { gyroDraw } from '../features/gyro/gyro.js';
import { readShipJson, testCatalog } from '../testData.js';
import type { ShipTuning } from '../tuning.js';
import type { ShipDerived } from '../rebuild.js';
import { P_THRUSTER, P_TOOL, TK_GYRO, TK_STRAFER, portsDigest } from './ports.js';
import { portsLoadTest } from './portsLoadTest.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const p = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });
const E = { facing: 'E' as Side };

/**
 * A 2×1 core at (0,0)-(1,0); a Burst Strafer at (3,0) facing E (it dodges the ship left), fed by a Cell Reactor at (2,0)
 * turned to give E; a Gyro at (0,1) and a Deflector at (1,1), each fed by a Cell Reactor under it. `fed: false` leaves
 * out the three reactors that feed them (a hull cell in each place, so the shape stays)
 */
function design(fed = true): Blueprint {
  const src = (uid: number, x: number, y: number, rot: number) => (fed ? p(uid, 'sq', 'power_cell_reactor', x, y, { rot: rot as Rot }) : p(uid, 'sq', 'hull', x, y));
  return {
    name: 'test', catalogVersion: 1,
    parts: [
      p(0, 'rect2', 'core', 0, 0),
      src(1, 2, 0, 1), p(2, 'sq', 'engine_burst_strafer', 3, 0, E),
      p(3, 'sq', 'utility_gyro', 0, 1), src(4, 0, 2, 0),
      p(5, 'sq', 'shield_deflector', 1, 1), src(6, 1, 2, 0),
    ],
  };
}
const derived = (fed = true) => createShipState(catalog, tuning, 1, design(fed), 0).derived;
const idx = (d: ShipDerived, fn: string) => d.alive.findIndex((_, i) => design().parts[i].fn === fn);
const NONE: FlightControls = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: -Math.PI / 2 };
const body = (): FlightBody => ({ x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0 });
/** Fly `ticks` with the power accounted (the server and the pilot's own prediction), the controls' bits and power each tick */
function fly(b: FlightBody, d: ShipDerived, c: Partial<FlightControls>, ticks: number, ch: { c: Charge }, bits?: number[]) {
  for (let i = 0; i < ticks; i++) {
    const r = stepShipPhysics(b, { ...NONE, ...c }, d, tuning, { charge: ch.c, drainRate: 1 });
    ch.c = r.charge;
    bits?.push(controlBits({ ...NONE, ...c }) | r.ctlPower);
  }
}
const lateral = (b: FlightBody) => worldToLocalDir([b.vx, b.vy], b.angle)[0];

describe('ports: Burst Strafers, Gyros and shields draw power', () => {
  it('lays them out as thrusters with their own buffers, and a shield as a tool', () => {
    const d = derived(), L = d.ports!, s = idx(d, 'engine_burst_strafer'), g = idx(d, 'utility_gyro'), sh = idx(d, 'shield_deflector');
    expect([L.role[s], L.thrustKind[s]]).toEqual([P_THRUSTER, TK_STRAFER]);
    expect([L.role[g], L.thrustKind[g]]).toEqual([P_THRUSTER, TK_GYRO]);
    expect([L.role[sh], L.shield[sh]]).toEqual([P_TOOL, 1]);
    // (700 E/s a burst, a 140 E buffer: one burst; the Gyro 6 E/s turning flat out; the Deflector 16 E/s, always)
    expect([L.strafeDraw, L.gyroDraw, L.shieldDraw]).toEqual([700, 6, 16]);
    expect(L.cap[s]).toBe(140 * 256);
    // Each fed by its reactor, up to 35 E/s
    for (const q of [s, g, sh]) expect(L.inStart[q + 1] - L.inStart[q]).toBe(1);
    expect(gyroDraw(d)).toBeCloseTo(6, 0);
    expect(burstEnergy(d, DODGE_LEFT)).toBeCloseTo(140, 0);
  });

  it('idle, a strafer and a gyro draw nothing (their buffers stay full); a fed shield is fully met, an unfed one runs dry', () => {
    for (const fed of [true, false]) {
      const d = derived(fed), L = d.ports!, ch = { c: fullPortsCharge(d) }, b = body();
      fly(b, d, {}, 600, ch);
      expect(ch.c.e!.held[idx(d, 'engine_burst_strafer')]).toBe(L.cap[idx(d, 'engine_burst_strafer')]);
      expect(ch.c.e!.held[idx(d, 'utility_gyro')]).toBe(L.cap[idx(d, 'utility_gyro')]);
      expect(shieldShare(d, ch.c)).toBe(fed ? 1 : 0);
    }
    // (A pool ship's, or one whose power isn't accounted: 1)
    expect(shieldShare(derived(), FULL_CHARGE)).toBe(1);
  });

  it('a shield power cannot reach adds nothing (as a cut-off jump coil: power/ports.ts portsFed); one reached counts whole', () => {
    expect(derived(true).shieldMax).toBe(40);
    expect(derived(true).shieldRegen).toBe(8);
    expect(derived(false).shieldMax).toBe(0);
    expect(derived(false).shieldRegen).toBe(0);
  });

  // (No movement key held: the dodge goes sideways, the one way this strafer pushes, and the core's maneuvering adds nothing)
  it('a dodge burns the strafer\'s buffer; the next one straight after is short or refused; its line refills it', () => {
    const d = derived(), L = d.ports!, s = idx(d, 'engine_burst_strafer');
    // A first burst from a full buffer pushes as hard as one with no power accounting at all
    const free = body();
    for (let t = 0; t < 30; t++) stepShipPhysics(free, { ...NONE, dodge: t < 20 }, d, tuning, { charge: FULL_CHARGE, drainRate: 0 });
    const ch = { c: fullPortsCharge(d) }, b = body();
    fly(b, d, { dodge: true }, 20, ch);
    fly(b, d, {}, 10, ch);
    expect(lateral(b)).toBeLessThan(-0.5);
    expect(lateral(b)).toBeCloseTo(lateral(free), 9);
    // (its buffer spent, and a 35 E/s reactor puts back ~20 E in the meantime)
    expect(ch.c.e!.held[s]).toBeLessThan(L.cap[s] / 4);
    expect(dodgeAffordable(d, ch.c, DODGE_LEFT)).toBeLessThan(0.5);
    // Straight after: much less push than the first
    const v0 = lateral(b);
    fly(b, d, { dodge: true }, 20, ch);
    fly(b, d, {}, 10, ch);
    expect(lateral(b) - v0).toBeGreaterThan(0.6 * lateral(free));
    // Four seconds on its line and it's full again
    fly(b, d, {}, 240, ch);
    expect(ch.c.e!.held[s]).toBe(L.cap[s]);
    expect(dodgeAffordable(d, ch.c, DODGE_LEFT)).toBe(1);
  });

  it('an unfed strafer has one burst in its buffer, then nothing', () => {
    const d = derived(false), ch = { c: fullPortsCharge(d) }, b = body();
    fly(b, d, { dodge: true }, 20, ch);
    fly(b, d, {}, 10, ch);
    expect(lateral(b)).toBeLessThan(-0.5);
    fly(b, d, {}, 300, ch);
    const v2 = lateral(b);
    fly(b, d, { dodge: true }, 20, ch);
    fly(b, d, {}, 10, ch);
    // (no push: the velocity only decays)
    expect(Math.abs(lateral(b))).toBeLessThanOrEqual(Math.abs(v2) + 1e-9);
  });

  it('a gyro turns by its fulfilment: fed, as if power were free; unfed, weaker once its buffer is spent', () => {
    // (Weaving: the aim swings a quarter turn either way every half second, so the turn keeps taking the whole cap)
    const turn = (fed: boolean, accounted: boolean) => {
      const d = derived(fed), ch = { c: fullPortsCharge(d) }, b = body(), angles: number[] = [];
      let low = Infinity;
      for (let t = 0; t < 600; t++) {
        const r = stepShipPhysics(b, { ...NONE, targetAngle: -Math.PI / 2 + (Math.floor(t / 30) % 2 ? 0.8 : -0.8) }, d, tuning, accounted ? { charge: ch.c, drainRate: 1 } : { charge: FULL_CHARGE, drainRate: 0 });
        ch.c = r.charge; angles.push(b.angle);
        if (ch.c.e) low = Math.min(low, ch.c.e.held[idx(d, 'utility_gyro')]);
      }
      return { angles, low, cap: d.ports!.cap[idx(d, 'utility_gyro')] };
    };
    const free = turn(true, false), fed = turn(true, true), unfed = turn(false, true);
    expect(fed.angles).toEqual(free.angles);
    // (fed: it drew, and its 35 E/s line keeps it near full; unfed: its buffer spent, it turns less)
    expect(fed.low).toBeLessThan(fed.cap);
    expect(fed.low).toBeGreaterThan(fed.cap / 2);
    expect(unfed.low).toBe(0);
    // (Short of its torque it turns, and brakes, less: it overshoots the aim, swinging past 0.8 where the fed one stops at it)
    const swing = (a: number[]) => a.slice(300).reduce((m, v) => Math.max(m, Math.abs(v + Math.PI / 2)), 0);
    expect(swing(fed.angles)).toBeLessThan(0.81);
    expect(swing(unfed.angles)).toBeGreaterThan(swing(fed.angles) + 0.02);
  });

  it('is deterministic, and a replica flown on the control bits (power and the features\' share) matches the pilot', () => {
    const inputs: Partial<FlightControls>[] = [];
    for (let t = 0; t < 240; t++) inputs.push({ forward: t < 40, left: t >= 30 && t < 60, targetAngle: -Math.PI / 2 + (t < 120 ? t * 0.03 : 3.6 - (t - 120) * 0.02), dodge: (t >= 30 && t < 45) || (t >= 50 && t < 60) || (t >= 200 && t < 210) });
    for (const fed of [true, false]) {
      const d = derived(fed), runs = [0, 1].map(() => { const ch = { c: fullPortsCharge(d) }, b = body(), bits: number[] = []; for (const c of inputs) fly(b, d, c, 1, ch, bits); return { b, bits, dig: portsDigest(d.ports!, ch.c.e!) }; });
      expect(runs[1].b).toEqual(runs[0].b);
      expect(runs[1].dig).toBe(runs[0].dig);
      const r = body();
      inputs.forEach((c, t) => stepShipPhysics(r, { ...NONE, ...c }, d, tuning, { charge: FULL_CHARGE, drainRate: 0, replay: runs[0].bits[t] }));
      expect(r).toEqual(runs[0].b);
    }
  });

  it('the load test runs them when boosting: the gyro turning, the strafer weaving; an unfed pair falls short', () => {
    const fed = portsLoadTest(derived(), 'boost')!, unfed = portsLoadTest(derived(false), 'boost')!;
    const s = idx(derived(), 'engine_burst_strafer'), g = idx(derived(), 'utility_gyro');
    expect([fed.used[s], fed.used[g]]).toEqual([1, 1]);
    expect(fed.end[g]).toBe(1);
    // (35 E/s into a 700 E/s burst every 25 ticks: a twentieth of it, about)
    expect(fed.end[s]).toBeLessThan(0.3);
    expect(unfed.moves).toBe(0);
    expect(portsLoadTest(derived(), 'fire')!.used[s]).toBe(0);
  });
});
