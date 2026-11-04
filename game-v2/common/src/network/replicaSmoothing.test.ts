import { describe, expect, it } from 'vitest';
import { ShipReplicaSet, packKeyframe, packControlRow } from './replication.js';
import { ReplicaMode, type ShipDerived, type ShipTuning, type ReplicaEnv } from '../ships/index.js';

/** A drifting ship (no controls: the client steps it exactly as it was sent) */
const set = () => new ShipReplicaSet({} as ShipTuning, () => ({}) as ShipDerived, () => ({}) as ReplicaEnv);
const key = (x: number, vx: number) => packKeyframe({ id: 1, mode: ReplicaMode.Drift, body: { x, y: 0, vx, vy: 0, angle: 0, angVel: 0 }, ctl: { bits: 0, targetAngle: 0 }, q: 0 });

/** Draw it frame by frame (quarter ticks) from `from` to `to`, a keyframe applied when the view reaches each `at` */
function draw(r: ShipReplicaSet, from: number, to: number, keys: { at: number; tick: number; row: number[] }[]): { t: number; x: number }[] {
  const out: { t: number; x: number }[] = [];
  for (let t = from; t <= to + 1e-9; t += 0.25) {
    for (const k of keys) if (Math.abs(k.at - t) < 1e-9) r.apply(k.tick, [k.row]);
    out.push({ t, x: r.pose(1, t)!.x });
  }
  return out;
}

describe('a keyframe moving a drawn ship off its predicted path (ShipReplicaSet.pose)', () => {
  it('bends the drawn path onto it: no jump ahead, no step, exact from its tick on', () => {
    const r = set();
    r.apply(100, [key(0, 4)]);
    // At tick 106 it is really 30 further on (shoved): that keyframe arrives while the view is at 102
    const truth = r.at(1, 106)!.body.x + 30;
    const path = draw(r, 100, 114, [{ at: 102, tick: 106, row: key(truth, 4) }]);
    const steps = path.slice(1).map((p, i) => p.x - path[i].x);
    // Before: the ticks between the last stepped one and the keyframe showed the keyframe early (a jump of ~40, then
    // standing still); now every frame moves forward, by no more than a little over its speed plus the shove spread out
    for (const d of steps) { expect(d).toBeGreaterThan(0); expect(d).toBeLessThan(4); }
    // From the keyframe's tick it is drawn where it is
    expect(r.pose(1, 106)!.x).toBeCloseTo(truth, 6);
    expect(r.pose(1, 110)!.x).toBeCloseTo(r.at(1, 110)!.body.x, 6);
    // ... and the states themselves are exact
    expect(r.at(1, 106)!.body.x).toBe(truth);
  });

  it('a keyframe that comes after its tick is drawn eases out after it, without a step', () => {
    const r = set();
    r.apply(100, [key(0, 4)]);
    const truth = r.at(1, 104)!.body.x + 20;
    const path = draw(r, 100, 120, [{ at: 105, tick: 104, row: key(truth, 4) }]);
    for (let i = 1; i < path.length; i++) expect(Math.abs(path[i].x - path[i - 1].x)).toBeLessThan(4);
    expect(r.pose(1, 120)!.x).toBeCloseTo(r.at(1, 120)!.body.x, 6);
  });

  it('a teleport snaps', () => {
    const r = set();
    r.apply(100, [key(0, 4)]);
    const path = draw(r, 100, 108, [{ at: 102, tick: 106, row: key(5000, 4) }]);
    expect(path.find((p) => p.t === 106)!.x).toBe(5000);
  });
});

describe('debris steps as a world (ShipReplicaSet.stepDebrisTo)', () => {
  it('a control row or a rewind for a piece already stepped past leaves it moving, not frozen', () => {
    const r = set();
    r.apply(100, [key(0, 4)]);
    const at104 = r.at(1, 104)!.body.x;
    expect(at104).toBeGreaterThan(0);
    // (a control row naming it: debris has no controls, ignored)
    r.apply(104, [], [packControlRow(1, [[2, 0, 0]], 0)]);
    expect(r.at(1, 106)!.body.x).toBeGreaterThan(at104);
    // (a rewind, as the causes layer does: stepped again from there)
    const at106 = r.at(1, 106)!.body.x;
    r.rewind(1, 102);
    expect(r.at(1, 106)!.body.x).toBe(at106);
    expect(r.at(1, 108)!.body.x).toBeGreaterThan(at106);
  });
});

describe('a path stepped again where it was drawn already (ShipReplicaSet.pose)', () => {
  it('eases the change out from where it was drawn, no jump; exact again once eased out', () => {
    const square: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const shape = { mass: 4, radius: 15, com: [0, 0] as [number, number], pieces: [square] };
    const r = new ShipReplicaSet({ cellSize: 10 } as ShipTuning, () => ({}) as ShipDerived, () => ({}) as ReplicaEnv, undefined, () => shape);
    r.apply(100, [key(0, 1)]);
    // Drawn ahead of what it's been told, to 103.5
    for (let t = 100; t <= 103.5; t += 0.25) r.pose(1, t);
    const was = r.pose(1, 103.5)!.x;
    // A piece it hadn't heard of turns up at 101, right beside it: it was knocked from 102 on
    r.spawnDebris(2, 101, { x: -12, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 });
    const truth = r.at(1, 104)!.body.x;
    const next = r.pose(1, 103.75)!.x;
    // (the new path is well off the drawn one; the drawing carries on from where it was)
    expect(Math.abs(r.at(1, 103)!.body.x - was)).toBeGreaterThan(1);
    expect(Math.abs(next - was)).toBeLessThan(1);
    expect(r.pose(1, 104)!.x).not.toBe(truth);
    expect(r.pose(1, 116)!.x).toBe(r.at(1, 116)!.body.x);
  });
});
