/**
 * Docking Clamps in a client's replica set (ShipReplicaSet: noteClampLink, noteClampBreak; common sim/clampPair.ts):
 * the follower's replica sits where its leader puts it, from the link's tick, with no rows or keyframes of its own; a
 * link that comes late steps both again from its tick; a late control row of the leader moves the follower too; a
 * break lets each fly on alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../ships/blueprint.js';
import { createShipState, type ShipState } from '../ships/state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../ships/testData.js';
import type { ShipTuning } from '../ships/tuning.js';
import { CTL, ReplicaMode, type ReplicaEnv } from '../ships/replica.js';
import { clampOffset, followerPose } from '../ships/features/clamp/clamp.js';
import { ShipReplicaSet, packKeyframe, packControlRow, quantizeReplicaAngle } from './replication.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const sparrow = readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8');
const UP = -1.5708;

function clamped(id: number, side: 'E' | 'W'): ShipState {
  const bp = parseBlueprint(sparrow);
  bp.parts.push({ uid: 60, piece: 'sq', fn: 'docking_clamp', material: 'alloy', x: side === 'E' ? 3 : -2, y: 0, rot: 0, flip: false, facing: side } as never);
  return createShipState(catalog, tuning, id, bp, 0);
}

const L = 5, F = 9;
const A = clamped(L, 'E'), B = clamped(F, 'W');
const ca = A.derived.fx!.clamp!.clamps[0], cb = B.derived.fx!.clamp!.clamps[0];
const offset = clampOffset(ca, A.derived.com, cb, B.derived.com, tuning.cellSize);

function setUp() {
  const reps = new ShipReplicaSet(tuning, (id) => (id === L ? A.derived : id === F ? B.derived : null), (): ReplicaEnv => ({ gravity: null, central: null }));
  const lead = { x: 100, y: 200, vx: 0, vy: 0, angle: UP, angVel: 0 };
  const f = followerPose(lead, offset);
  reps.apply(10, [
    packKeyframe({ id: L, mode: ReplicaMode.Player, body: lead, ctl: { bits: 0, targetAngle: 0 }, q: quantizeReplicaAngle(UP) }),
    packKeyframe({ id: F, mode: ReplicaMode.Player, body: { ...f, x: f.x + 4 }, ctl: { bits: CTL.hold, targetAngle: 0 }, q: 0 }),
  ]);
  return reps;
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('docking clamps in the replica set', () => {
  it('a follower rides its leader from the link on, the leader flying the pair', () => {
    const reps = setUp();
    reps.apply(12, [], [packControlRow(L, [[1, CTL.forward, quantizeReplicaAngle(UP)]], quantizeReplicaAngle(UP))]);
    reps.noteClampLink({ tick: 11, leader: L, follower: F, lc: ca.uid, fc: cb.uid, offset });
    for (let t = 11; t <= 70; t++) {
      const lb = reps.at(L, t)!.body, fb = reps.at(F, t)!.body;
      const p = followerPose(lb, offset);
      expect([fb.x, fb.y, fb.angle, fb.vx, fb.vy]).toEqual([p.x, p.y, p.angle, p.vx, p.vy]);
      expect(reps.clampPartner(L, t)).toBe(F);
    }
    expect(reps.at(L, 70)!.body.y).toBeLessThan(200 - 20);
  });

  it('a late control row of the leader moves its follower too; a link that comes late steps both again', () => {
    const reps = setUp();
    reps.noteClampLink({ tick: 11, leader: L, follower: F, lc: ca.uid, fc: cb.uid, offset });
    const before = { ...reps.at(F, 60)!.body };
    // (The leader's row for tick 20, heard after tick 60 was stepped)
    reps.apply(25, [], [packControlRow(L, [[5, CTL.forward | CTL.boost, quantizeReplicaAngle(UP)]], quantizeReplicaAngle(UP))]);
    const after = reps.at(F, 60)!.body;
    expect(near(after, before)).toBeGreaterThan(5);
    expect(near(after, followerPose(reps.at(L, 60)!.body, offset))).toBeLessThan(0.02);

    // A set that stepped past the link's tick before hearing of it
    const late = setUp();
    late.apply(25, [], [packControlRow(L, [[5, CTL.forward | CTL.boost, quantizeReplicaAngle(UP)]], quantizeReplicaAngle(UP))]);
    late.at(F, 60); late.at(L, 60);
    late.noteClampLink({ tick: 11, leader: L, follower: F, lc: ca.uid, fc: cb.uid, offset });
    expect(late.at(F, 60)!.body).toEqual(reps.at(F, 60)!.body);
    expect(late.at(L, 60)!.body).toEqual(reps.at(L, 60)!.body);
  });

  it('a break lets each fly on alone, with an undock\'s push', () => {
    const reps = setUp();
    reps.noteClampLink({ tick: 11, leader: L, follower: F, lc: ca.uid, fc: cb.uid, offset });
    reps.noteClampBreak({ tick: 40, a: L, b: F, push: [-1.5, 0] });
    const d0 = near(reps.at(L, 39)!.body, reps.at(F, 39)!.body);
    const d1 = near(reps.at(L, 80)!.body, reps.at(F, 80)!.body);
    expect(reps.clampPartner(L, 39)).toBe(F);
    expect(reps.clampPartner(L, 40)).toBeUndefined();
    expect(d1).toBeGreaterThan(d0 + 40);
  });
});
