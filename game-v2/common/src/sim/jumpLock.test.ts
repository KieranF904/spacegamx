/**
 * A jump goes where it was aimed as its charge started (Kieran, 2026-11-07: "i click on sol station to jump to it, then
 * move my cursor, it jumps to my new cursor location; it should jump to wherever my cursor was when i initiated it").
 * The destination (heading and distance) is locked into the body on the charge's first tick (flight.ts
 * FlightBody.jumpAim/jumpTo); the aim and distance after it change nothing of the jump. A cancel and a new start lock
 * anew; at the helm the nose is locked. Every end agrees: the pilot on its raw aims with the held-aim rule, a copy on
 * the applied aims, a replica (which doesn't know the distance) and a replica that had a keyframe mid-charge.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../ships/blueprint.js';
import { createShipState } from '../ships/state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../ships/testData.js';
import type { ShipTuning } from '../ships/tuning.js';
import { FULL_CHARGE } from '../ships/energy.js';
import { NO_FIELDS } from '../ships/jumpFields.js';
import { CTL, ReplicaMode, replicaStep } from '../ships/replica.js';
import { jumpBurnAt, jumpTuning, jumpReachAt, wrapAngle, helmJumpAim, type FlightBody } from '../ships/flight.js';
import { packKeyframe, unpackKeyframe } from '../network/replication.js';
import { newSimShip, simAim, simAimQ, NO_INPUT, stepShip, type SimEnv, type SimInput, type SimShipState } from './index.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const jt = jumpTuning(tuning);
const burnAt = jumpBurnAt(jt);
const envAt = (t: number): SimEnv => ({ tick: t, tuning, gravity: null, fields: NO_FIELDS, terrain: null });
const REPLICA_ENV = { gravity: null, central: null };
const make = () => createShipState(catalog, tuning, 7, parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/fixtures/sparrow-t.json'), 'utf-8')), 0);
const sim = (angle = 0): SimShipState => {
  const s = make();
  return newSimShip({ id: 7, derived: s.derived, ship: s, body: { x: 0, y: 0, vx: 0, vy: 0, angle, angVel: 0, jump: 0, cargo: 0 }, charge: FULL_CHARGE, accounted: true });
};

/** Fly `script` until the burn is over (or `ticks`): where it ended, its heading, and the body every tick */
function fly(script: (t: number) => SimInput, s = sim(), ticks = 700): { s: SimShipState; bodies: FlightBody[]; burnTick: number } {
  const bodies: FlightBody[] = [];
  let burnTick = -1;
  for (let t = 1; t <= ticks; t++) {
    stepShip(s, script(t), envAt(t), s, []);
    bodies.push({ ...s.body });
    if (burnTick < 0 && s.body.jump === burnAt) burnTick = t;
    // (its last burn tick: from the next the drive cools, and the ship turns to the aim again)
    if (burnTick > 0 && (s.body.jump ?? 0) >= burnAt + jt.burnTicks - 1) break;
  }
  return { s, bodies, burnTick };
}

/** A body as compared (absent counters as their defaults), its lock too */
const row = (b: FlightBody) => [b.x, b.y, b.vx, b.vy, b.angle, b.angVel, b.jump ?? 0, b.jumpScale ?? 1, b.jumpAim, b.jumpTo];
const jumpIn = (q: number, jumpDist: number, bits = CTL.jump): SimInput => ({ ...NO_INPUT, q, bits, jumpDist });
const A = simAimQ(0.6), B = simAimQ(-2.2);

describe('a jump goes where it was aimed as its charge started (flight.ts FlightBody.jumpAim/jumpTo)', () => {
  it('the bug: aimed at a point, the cursor then moved (aim and distance) all through the charge, it lands at the first point', () => {
    // (Aimed at A 9k away as J goes down, then the cursor wanders off: the far side, 30k, never still)
    const moved = fly((t) => (t === 1 ? jumpIn(A, 9000) : jumpIn(simAimQ(-2.2 + 0.3 * Math.sin(t / 7)), 30000 + 40 * t)));
    // (and the same jump with the cursor left where it was)
    const still = fly(() => jumpIn(A, 9000));
    expect(moved.burnTick).toBe(burnAt);
    const end = moved.s.body;
    // Bit for bit the jump the still cursor made: the same heading, the same place
    expect(end).toEqual(still.s.body);
    expect(Math.abs(wrapAngle(end.angle - simAim(A)))).toBeLessThan(1e-5);
    expect(Math.abs(Math.hypot(end.x, end.y) - 9000)).toBeLessThan(40);
    // (The lock lasts the charge only)
    expect(end.jumpAim).toBeUndefined();
    expect(moved.bodies[5].jumpAim).toBe(simAim(A));
    expect(moved.bodies[5].jumpTo).toBe(9000);
  });

  it('a target snapped to on the map (its bearing and stop distance in the first input) stays the destination', () => {
    // (What the client sends as J goes down over a station on the map: the station's bearing, its distance less the stop)
    const station = { x: 12000, y: -5000 }, stop = 1500;
    const q = simAimQ(Math.atan2(station.y, station.x)), d = Math.round((Math.hypot(station.x, station.y) - stop) / 4) * 4;
    // (then the map's cursor leaves the station: the plain cursor, somewhere else entirely)
    const r = fly((t) => (t === 1 ? jumpIn(q, d) : jumpIn(simAimQ(2.9), 800)));
    const far = Math.hypot(station.x - r.s.body.x, station.y - r.s.body.y);
    expect(Math.abs(far - stop)).toBeLessThan(40);
  });

  it('let go mid-charge and started again: the new start locks anew (where the cursor is then)', () => {
    const r = fly((t) => (t < 60 ? jumpIn(A, 9000) : t === 60 ? jumpIn(B, 9000, 0) : t === 61 ? jumpIn(B, 15000) : jumpIn(simAimQ(1.3), 4000)));
    expect(r.bodies[58].jumpAim).toBe(simAim(A));
    // (Let go: no charge, no lock)
    expect(r.bodies[59].jump).toBe(0);
    expect(r.bodies[59].jumpAim).toBeUndefined();
    expect(r.bodies[60].jumpAim).toBe(simAim(B));
    expect(r.burnTick).toBe(60 + burnAt);
    const end = r.s.body;
    expect(Math.abs(wrapAngle(end.angle - simAim(B)))).toBeLessThan(1e-5);
    expect(Math.abs(Math.hypot(end.x, end.y) - 15000)).toBeLessThan(60);
  });

  it('at the helm: the nose as the charge starts is the heading, whatever the turn keys and the cursor distance do after', () => {
    const nose = 0.9;
    const r = fly((t) => jumpIn(simAimQ(-1), t === 1 ? 12000 : 3000, CTL.jump | CTL.helm | (t > 1 ? CTL.right : 0)), sim(nose));
    expect(r.bodies[0].jumpAim).toBe(helmJumpAim(nose));
    const end = r.s.body;
    expect(Math.abs(wrapAngle(end.angle - nose))).toBeLessThan(0.001);
    expect(Math.abs(Math.hypot(end.x, end.y) - 12000)).toBeLessThan(40);
  });

  it('the held aim: once locked, the cursor moving through the charge is held (nothing to send for the jump), and the copy flies the same', () => {
    const rule = sim(), copy = sim(), raw = sim();
    let last: number | undefined, moved = 0, held = 0;
    for (let t = 1; t < burnAt + jt.burnTicks; t++) {
      const input = t === 1 ? jumpIn(A, 9000) : jumpIn(simAimQ(0.6 + 1.7 * Math.sin(t / 11)), 9000 + 8 * t);
      stepShip(raw, input, envAt(t), raw, []);
      stepShip(rule, { ...input, heldQ: last }, envAt(t), rule, []);
      const applied = rule.ctl.q;
      if (t > 1 && last !== undefined && input.q !== last) { moved++; if (applied === last) held++; }
      // (The charge's first tick takes the aim: it is the lock)
      if (t === 1) expect(applied).toBe(A);
      last = applied;
      stepShip(copy, { ...input, q: applied }, envAt(t), copy, []);
      expect(copy.body, `tick ${t}`).toEqual(raw.body);
      expect(rule.body, `tick ${t}`).toEqual(raw.body);
    }
    expect(moved).toBeGreaterThan(100);
    // (No guns firing: every move held, the whole charge and burn)
    expect(held).toBe(moved);
  });

  it('a replica: it locks on its own first charging tick, turns as the pilot does, and with a keyframe mid-charge burns exactly as the pilot', () => {
    const pilot = sim();
    const rep: FlightBody = { ...pilot.body };
    let mid: FlightBody | null = null;
    const script = (t: number) => (t === 1 ? jumpIn(A, 9000) : jumpIn(simAimQ(-1 + 0.8 * Math.sin(t / 5)), 20000));
    for (let t = 1; t < burnAt + jt.burnTicks; t++) {
      const input = script(t);
      stepShip(pilot, input, envAt(t), pilot, []);
      const d = pilot.structure.derived;
      // The replica of the pilot (no distance: -1), on what the control row carries
      replicaStep(ReplicaMode.Player, rep, { bits: pilot.ctl.bits, targetAngle: simAim(pilot.ctl.q) }, d, tuning, REPLICA_ENV, t);
      // ...and one that had a keyframe of it at tick 90 (the lock rides it: replication.ts packKeyframe)
      if (t === 90) mid = unpackKeyframe(packKeyframe({ id: 7, mode: ReplicaMode.Player, body: pilot.body, ctl: { bits: pilot.ctl.bits, targetAngle: 0 }, q: pilot.ctl.q })).body;
      else if (mid) replicaStep(ReplicaMode.Player, mid, { bits: pilot.ctl.bits, targetAngle: simAim(pilot.ctl.q) }, d, tuning, REPLICA_ENV, t);
      if (t === 90) {
        expect(mid!.jumpAim).toBe(pilot.body.jumpAim);
        expect(mid!.jumpTo).toBe(9000);
      }
      if ((pilot.body.jump ?? 0) < burnAt) {
        // Charging: the same heading and turn (the replica's charge waits at its end: it doesn't know the distance)
        expect([rep.angle, rep.angVel, rep.jumpAim], `tick ${t}`).toEqual([pilot.body.angle, pilot.body.angVel, pilot.body.jumpAim]);
        expect(rep.jumpTo).toBe(-1);
      }
      if (mid) expect(row(mid), `keyframed, tick ${t}`).toEqual(row(pilot.body));
    }
    expect(Math.abs(Math.hypot(pilot.body.x, pilot.body.y) - 9000)).toBeLessThan(40);
  });

  it('a keyframe carries the lock exactly (mouse and helm), and none when there is none', () => {
    for (const jumpAim of [simAim(A), simAim(B), helmJumpAim(0.9), helmJumpAim(-3.1), helmJumpAim(3.14159)]) {
      const body: FlightBody = { x: 1, y: 2, vx: 0, vy: 0, angle: 0.5, angVel: 0, jump: 40, jumpAim, jumpTo: 4800 };
      const k = unpackKeyframe(packKeyframe({ id: 2, mode: ReplicaMode.Player, body, ctl: { bits: CTL.jump, targetAngle: 0 }, q: 10 }));
      expect([k.body.jumpAim, k.body.jumpTo]).toEqual([jumpAim, 4800]);
    }
    const plain = unpackKeyframe(packKeyframe({ id: 2, mode: ReplicaMode.Player, body: { x: 1, y: 2, vx: 0, vy: 0, angle: 0.5, angVel: 0, jump: 0 }, ctl: { bits: 0, targetAngle: 0 }, q: 10 }));
    expect(plain.body.jumpAim).toBeUndefined();
    expect(packKeyframe({ id: 2, mode: ReplicaMode.Player, body: { x: 1, y: 2, vx: 0, vy: 0, angle: 0.5, angVel: 0, jump: 0 }, ctl: { bits: 0, targetAngle: 0 }, q: 10 }).length).toBe(12);
  });

  it('(the rig: the drive reaches the distances asked)', () => {
    expect(jumpReachAt(make().derived, jt)).toBeGreaterThan(20000);
  });
});
