/**
 * Docking Clamps' joined flight (sim/clampPair.ts): the joined structure, the exact snap, and the pair stepped alike by
 * the steering pilot's whole step (accounted, stores and all), the other pilot's (riding the leader) and a replica's
 * (the leader's control bits only), tick for tick; a swap keeps the pose continuous; an undock's push.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../ships/blueprint.js';
import { createShipState, type ShipState } from '../ships/state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../ships/testData.js';
import type { ShipTuning } from '../ships/tuning.js';
import type { FlightBody } from '../ships/flight.js';
import { NO_FIELDS } from '../ships/jumpFields.js';
import { CTL, ReplicaMode, replicaStep, controlBits } from '../ships/replica.js';
import { clampOffset, clampWorld, clampFit, clampLinedUp, followerPose } from '../ships/features/clamp/clamp.js';
import { stepOwnShip, ownStructure, seedOwnExtras, NO_OWN_INPUT } from './ownStep.js';
import { simAimQ } from './input.js';
import { replicaAngle } from '../network/replication.js';
import { ClampLinks, linksSource, joinDerived, stepPairBody, type ClampSource } from './clampPair.js';
import type { SimEnv } from './env.js';
import type { OwnExtras } from './headHash.js';
import type { ReplicaEnv } from '../ships/replica.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const sparrow = readFileSync(join(SHIP_DATA_DIR, 'blueprints/fixtures/sparrow-t.json'), 'utf-8');
const CS = tuning.cellSize;
const UP = -Math.PI / 2;

/** A Sparrow T with a Docking Clamp on its right (E) or left (W) */
function clamped(id: number, side: 'E' | 'W'): ShipState {
  const bp = parseBlueprint(sparrow);
  bp.parts.push({ uid: 60, piece: 'sq', fn: 'docking_clamp', material: 'alloy', x: side === 'E' ? 3 : -2, y: 0, rot: 0, flip: false, facing: side } as never);
  return createShipState(catalog, tuning, id, bp, 0);
}

const LEAD = 1, FOL = 2;
const A = clamped(LEAD, 'E'), B = clamped(FOL, 'W');
const ca = A.derived.fx!.clamp!.clamps[0], cb = B.derived.fx!.clamp!.clamps[0];
const OFFSET = clampOffset(ca, A.derived.com, cb, B.derived.com, CS);
const env = (t: number, clamp?: ClampSource): SimEnv => ({ tick: t, tuning, gravity: null, fields: NO_FIELDS, terrain: null, clamp });
const renv = (clamp?: ClampSource): ReplicaEnv => ({ gravity: null, central: null, clamp });
const derivedOf = (id: number) => (id === LEAD ? A.derived : B.derived);

/** The scripted steering: a run of keys and aims, boost now and then (tick 0-based) */
function script(i: number): { bits: number; aim: number } {
  const ph = Math.floor(i / 60) % 6;
  const keys = { forward: ph === 0 || ph === 3 || ph === 5, backward: ph === 2, left: ph === 1 || ph === 5, right: ph === 4, boost: ph === 3 && i % 120 < 50 };
  return { bits: controlBits(keys), aim: UP + Math.sin(i / 47) * 1.7 };
}

describe('docking clamps: the joined flight', () => {
  it('joins mass, inertia (parallel axis) and both ships\' thrusters', () => {
    const j = joinDerived(A.derived, B.derived, OFFSET);
    expect(j.derived.mass).toBeCloseTo(A.derived.mass + B.derived.mass, 9);
    expect(j.derived.inertia).toBeGreaterThan(A.derived.inertia + B.derived.inertia);
    expect(j.derived.thrusters.length).toBe(A.derived.thrusters.length + B.derived.thrusters.length);
    expect(j.derived.fx).toBeUndefined();
    // (Cached per structures and offset)
    expect(joinDerived(A.derived, B.derived, OFFSET)).toBe(j);
    expect(joinDerived(A.derived, B.derived, { ...OFFSET, ox: OFFSET.ox + 1 })).not.toBe(j);
  });

  it('the snap is exact: mouths together, facing each other, and lined up', () => {
    const lead = { x: 1000, y: -400, vx: 1.2, vy: -0.4, angle: 0.7, angVel: 0.012 };
    const f = followerPose(lead, OFFSET);
    const wa = clampWorld(ca, A.derived.com, CS, lead), wb = clampWorld(cb, B.derived.com, CS, f);
    expect(Math.abs(wa.x - wb.x)).toBeLessThan(0.02);
    expect(Math.abs(wa.y - wb.y)).toBeLessThan(0.02);
    expect(clampLinedUp(clampFit(wa, wb), lead, f)).toBe(true);
  });

  it('the pair\'s step round the joined centre leaves a still pair still', () => {
    const b: FlightBody = { x: 10, y: 20, vx: 0, vy: 0, angle: -1.5708, angVel: 0 };
    stepPairBody(b, joinDerived(A.derived, B.derived, OFFSET), () => {});
    expect([b.x, b.y, b.vx, b.vy, b.angle, b.angVel]).toEqual([10, 20, 0, 0, -1.5708, 0]);
  });

  it('flies alike on the steering pilot, the other pilot and a replica: 600 ticks', () => {
    const links = new ClampLinks();
    links.link({ leader: LEAD, follower: FOL, lc: ca.uid, fc: cb.uid, offset: OFFSET, tick: 1 });
    // The steering pilot's own whole step (stores, guns: what the server and its own client run) and the other pilot's
    // (it rides the leader as its own client has it: the leader's replica)
    let lead: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: UP, angVel: 0 };
    let fol: FlightBody = { ...followerPose(lead, OFFSET), jump: 0 };
    let lx: OwnExtras = seedOwnExtras(A), fx: OwnExtras = seedOwnExtras(B);
    let rLead: FlightBody = { ...lead }, rFol: FlightBody = { ...fol };
    const hist = new Map<number, { body: FlightBody; bits: number }>();
    const rhist = new Map<number, { body: FlightBody; bits: number }>();
    const own = linksSource(links, derivedOf, (id, t) => (id === LEAD ? hist.get(t) ?? null : null));
    const rep = linksSource(links, derivedOf, (id, t) => (id === LEAD ? rhist.get(t) ?? null : null));
    let moved = 0;
    for (let t = 1; t <= 600; t++) {
      const s = script(t);
      const q = simAimQ(s.aim);
      const sl = stepOwnShip(LEAD, lx, lead, s.bits, q, NO_OWN_INPUT, ownStructure(A.derived, A), env(t, own), []);
      lx = { charge: sl.charge, guns: sl.guns, hazard: sl.hazard, jumpPrime: sl.jumpPrime };
      hist.set(t, { body: { ...lead }, bits: sl.ctl.bits });
      // (The other pilot's own keys do nothing; its aim is its own)
      const sf = stepOwnShip(FOL, fx, fol, controlBits({ backward: true, right: true }), simAimQ(0.3), NO_OWN_INPUT, ownStructure(B.derived, B), env(t, own), []);
      fx = { charge: sf.charge, guns: sf.guns, hazard: sf.hazard, jumpPrime: sf.jumpPrime };
      // A third client's replicas: the leader from its control bits, the follower from the link
      replicaStep(ReplicaMode.Player, rLead, { bits: sl.ctl.bits, targetAngle: replicaAngle(ReplicaMode.Player, sl.ctl.q) }, A.derived, tuning, renv(rep), t, LEAD);
      rhist.set(t, { body: { ...rLead }, bits: sl.ctl.bits });
      replicaStep(ReplicaMode.Player, rFol, { bits: CTL.hold, targetAngle: 0 }, B.derived, tuning, renv(rep), t, FOL);
      expect([rLead.x, rLead.y, rLead.vx, rLead.vy, rLead.angle, rLead.angVel], `leader tick ${t}`).toEqual([lead.x, lead.y, lead.vx, lead.vy, lead.angle, lead.angVel]);
      expect([rFol.x, rFol.y, rFol.vx, rFol.vy, rFol.angle, rFol.angVel], `follower tick ${t}`).toEqual([fol.x, fol.y, fol.vx, fol.vy, fol.angle, fol.angVel]);
      // (Rigid: the follower always where the leader puts it)
      const p = followerPose(lead, OFFSET);
      expect([fol.x, fol.y, fol.angle]).toEqual([p.x, p.y, p.angle]);
      if (Math.abs(lead.vx) + Math.abs(lead.vy) > 0.5) moved++;
    }
    expect(moved).toBeGreaterThan(300);
    // (The follower's engines paid for the pair's thrust: its stores drew)
    expect(fx.charge).not.toEqual(seedOwnExtras(B).charge);
  });

  it('the pair is slower to push than the leader alone', () => {
    const links = new ClampLinks();
    links.link({ leader: LEAD, follower: FOL, lc: ca.uid, fc: cb.uid, offset: OFFSET, tick: 1 });
    const src = linksSource(links, derivedOf, () => null);
    const solo: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: UP, angVel: 0 }, pair: FlightBody = { ...solo };
    const bits = controlBits({ forward: true });
    for (let t = 1; t <= 30; t++) {
      replicaStep(ReplicaMode.Player, solo, { bits, targetAngle: UP }, A.derived, tuning, renv(), t, LEAD);
      replicaStep(ReplicaMode.Player, pair, { bits, targetAngle: UP }, A.derived, tuning, renv(src), t, LEAD);
    }
    expect(Math.hypot(pair.vx, pair.vy)).toBeGreaterThan(0);
    expect(Math.hypot(pair.vx, pair.vy)).toBeLessThan(Math.hypot(solo.vx, solo.vy));
  });

  it('a swap keeps the pose continuous, and an undock pushes the two apart', () => {
    const links = new ClampLinks();
    links.link({ leader: LEAD, follower: FOL, lc: ca.uid, fc: cb.uid, offset: OFFSET, tick: 1 });
    const back = clampOffset(cb, B.derived.com, ca, A.derived.com, CS);
    links.link({ leader: FOL, follower: LEAD, lc: cb.uid, fc: ca.uid, offset: back, tick: 50 });
    const at: Map<number, FlightBody>[] = [new Map(), new Map()];
    const src = linksSource(links, derivedOf, (id, t) => { const b = at[id === LEAD ? 0 : 1].get(t); return b ? { body: b, bits: 0 } : null; });
    const b = [{ x: 0, y: 0, vx: 0, vy: 0, angle: UP, angVel: 0 } as FlightBody, { ...followerPose({ x: 0, y: 0, vx: 0, vy: 0, angle: UP, angVel: 0 }, OFFSET) } as FlightBody];
    let gap0 = NaN;
    for (let t = 1; t <= 100; t++) {
      const s = script(t);
      // (Leader first: before tick 50 ship 1, from it ship 2; its keys steer)
      const order = t < 50 ? [0, 1] : [1, 0];
      for (const k of order) {
        const id = k === 0 ? LEAD : FOL;
        const was = { ...b[k] };
        replicaStep(ReplicaMode.Player, b[k], { bits: s.bits, targetAngle: s.aim }, derivedOf(id), tuning, renv(src), t, id);
        at[k].set(t, { ...b[k] });
        // (No jump at the swap: each moves on as it was moving)
        if (t === 50) expect(Math.hypot(b[k].x - was.x - was.vx, b[k].y - was.y - was.vy), `ship ${id} at the swap`).toBeLessThan(1);
      }
      const p = followerPose(t < 50 ? b[0] : b[1], t < 50 ? OFFSET : back);
      const f = t < 50 ? b[1] : b[0];
      expect(Math.hypot(f.x - p.x, f.y - p.y)).toBeLessThan(0.02);
      if (t === 100) gap0 = Math.hypot(b[1].x - b[0].x, b[1].y - b[0].y);
    }
    // Undock on 101: pushed apart along the clamps' line, then alone
    const n = clampWorld(cb, B.derived.com, CS, b[1]);
    links.unlink(FOL, LEAD, 101, [-n.nx * 1.5, -n.ny * 1.5]);
    for (let t = 101; t <= 140; t++) for (let k = 0; k < 2; k++) replicaStep(ReplicaMode.Player, b[k], { bits: CTL.hold, targetAngle: 0 }, derivedOf(k === 0 ? LEAD : FOL), tuning, renv(src), t, k === 0 ? LEAD : FOL);
    expect(Math.hypot(b[1].x - b[0].x, b[1].y - b[0].y)).toBeGreaterThan(gap0 + 20);
  });
});
