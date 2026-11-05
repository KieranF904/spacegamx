import { describe, expect, it } from 'vitest';
import { AnchorList, ImpactAnchor, rideStep } from './impactAnchor';

/** A target flying (vx, vy) a frame and turning w a frame from pose p0, at frame n */
const pose = (n: number, vx = 6, vy = -2, w = 0.03) => ({ x: 100 + vx * n, y: 50 + vy * n, angle: 0.4 + w * n });

describe('an impact anchored to its target', () => {
  it('its surface-bound parts follow a moving, turning target exactly, keeping their place on it', () => {
    const a = new ImpactAnchor(7, pose(0));
    // a point on the hull, 30 out along the target's angle and 10 across
    const off = { x: 30, y: 10 }, place = (n: number) => {
      const p = pose(n), c = Math.cos(p.angle - 0.4), s = Math.sin(p.angle - 0.4);
      return { x: p.x + off.x * c - off.y * s, y: p.y + off.x * s + off.y * c };
    };
    const pt = place(0);
    for (let n = 1; n <= 40; n++) {
      a.step(pose(n), 1);
      a.move(pt);
      const want = place(n);
      expect(pt.x).toBeCloseTo(want.x, 6);
      expect(pt.y).toBeCloseTo(want.y, 6);
    }
    // (a frame of two at once too)
    a.step(pose(42), 2);
    a.move(pt);
    expect(pt.x).toBeCloseTo(place(42).x, 6);
  });

  it("a free fragment is given the hit point's velocity: the target's plus its spin times the offset", () => {
    const a = new ImpactAnchor(7, pose(0));
    a.step(pose(1), 1);
    const v = a.pointVelocity(a.x + 20, a.y, { vx: 0, vy: 0 });
    expect(v.vx).toBeCloseTo(6, 6);
    expect(v.vy).toBeCloseTo(-2 + 0.03 * 20, 6);
    // (a point ahead of the centre on the other axis swings the other way)
    const u = a.pointVelocity(a.x, a.y + 20, { vx: 0, vy: 0 });
    expect(u.vx).toBeCloseTo(6 - 0.03 * 20, 6);
  });

  it("a gone target's group carries on with its last velocity and spin, smoothed, slowing a little", () => {
    const a = new ImpactAnchor(7, pose(0));
    for (let n = 1; n <= 5; n++) a.step(pose(n), 1);
    // (one noisy frame doesn't fling it: a jump is only half taken up)
    a.step({ ...pose(6), x: pose(6).x + 30 }, 1);
    expect(a.vx).toBeLessThan(6 + 30 * 0.6);
    for (let n = 7; n <= 20; n++) a.step(pose(n), 1);
    const x0 = a.x, y0 = a.y, ang0 = a.angle, pt = { x: a.x + 25, y: a.y };
    a.step(null, 1);
    expect(a.gone).toBe(true);
    expect(a.x - x0).toBeCloseTo(6, 0);
    expect(a.y - y0).toBeCloseTo(-2, 0);
    expect(a.angle - ang0).toBeCloseTo(0.03, 2);
    a.move(pt);
    expect(pt.x).toBeGreaterThan(x0 + 25);
    // and it keeps going, a little slower each frame
    const d1 = a.x - x0;
    for (let i = 0; i < 30; i++) a.step(null, 1);
    expect(a.x - x0).toBeGreaterThan(20 * d1);
    expect(a.vx).toBeLessThan(6);
    expect(a.vx).toBeGreaterThan(3);
  });

  it('a free particle flies in the frame of a target on a curved orbit: no smear, its path off the hit point is its own', () => {
    // a rock on a tight orbit (radius 600, a turn in 360 frames) spinning slowly, hit at frame 0
    const orbit = (n: number) => { const t = (n / 360) * Math.PI * 2; return { x: 600 * Math.cos(t), y: 600 * Math.sin(t), angle: 0.002 * n }; };
    const a = new ImpactAnchor(3, orbit(0), 600 - 40, 0);
    const rider = { x: 560, y: 0, vx: -4, vy: 1.5 }, alone = { x: 560, y: 0, vx: -4, vy: 1.5 };
    for (let n = 1; n <= 120; n++) {
      a.step(orbit(n), 1);
      rideStep(rider, a, 0.94, 1);
      rideStep(alone, undefined, 0.94, 1);
      // (where it is off the hit point is where it would be off a still one)
      expect(rider.x - a.hx).toBeCloseTo(alone.x - 560, 6);
      expect(rider.y - a.hy).toBeCloseTo(alone.y, 6);
    }
    // the hit point went round with the rock (a third of a turn) and turned with its spin, and the particle with it
    const end = orbit(120), c = Math.cos(end.angle), sn = Math.sin(end.angle);
    expect(a.hx).toBeCloseTo(end.x - 40 * c, 6);
    expect(a.hy).toBeCloseTo(end.y - 40 * sn, 6);
  });

  it('a rock placed once a tick, drawn at a higher frame rate: riders keep with it and its velocity reads steady', () => {
    // 144 frames a second (0.4167 of a tick each): the rock moves 6 a tick, only on the frames a tick turns over
    const frames = 60 / 144, at = (f: number) => ({ x: 6 * Math.floor(f * frames), y: 0, angle: 0 });
    const a = new ImpactAnchor(9, at(0));
    const rider = { x: 0, y: 0, vx: 0, vy: 0 };
    let lo = Infinity, hi = -Infinity;
    for (let f = 1; f <= 300; f++) {
      a.step(at(f), frames);
      rideStep(rider, a, 0.9, frames);
      expect(rider.x).toBeCloseTo(at(f).x, 6);
      if (f > 30) { lo = Math.min(lo, a.vx); hi = Math.max(hi, a.vx); }
    }
    // (6 a tick, give or take, never 0 or double: a gone rock coasts on about its real velocity)
    expect(lo).toBeGreaterThan(4);
    expect(hi).toBeLessThan(8);
  });

  it('a target that stops: its velocity eases to rest after a few still frames', () => {
    const a = new ImpactAnchor(4, pose(0));
    for (let n = 1; n <= 10; n++) a.step(pose(n), 1);
    for (let n = 0; n < 20; n++) a.step(pose(10), 1);
    expect(Math.abs(a.vx)).toBeLessThan(0.01);
  });

  it('an anchor list looks each target up once a frame and drops an anchor once nothing rides it', () => {
    const poses = new Map<number, { renderX: number; renderY: number; renderAngle: number }>([[5, { renderX: 0, renderY: 0, renderAngle: 0 }]]);
    const list = new AnchorList();
    expect(list.open(poses, 8, 0, 0)).toBeNull();
    expect(list.open(poses, -1, 0, 0)).toBeNull();
    const a = list.open(poses, 5, 10, 0)!;
    a.hold(10);
    poses.get(5)!.renderX = 7;
    list.step(poses, 1);
    expect(a.dx).toBeCloseTo(7, 9);
    // (still riding after 9 more frames, gone after the 10th and 11th, and carrying nothing then)
    for (let i = 0; i < 9; i++) list.step(poses, 1);
    expect(list.live.length).toBe(1);
    list.step(poses, 1);
    list.step(poses, 1);
    expect(list.live.length).toBe(0);
    expect(a.dx).toBe(0);
    const p = { x: 3, y: 4 };
    a.move(p);
    expect(p).toEqual({ x: 3, y: 4 });
  });

  it('its target gone, riders coast on with it', () => {
    const poses = new Map([[5, { renderX: 0, renderY: 0, renderAngle: 0 }]]);
    const list = new AnchorList(), a = list.open(poses, 5, 0, 0)!;
    a.hold(100);
    for (let n = 1; n <= 10; n++) { poses.get(5)!.renderX = 5 * n; list.step(poses, 1); }
    poses.delete(5);
    const r = { x: 50, y: 0, vx: 0, vy: 0 };
    list.step(poses, 1);
    rideStep(r, a, 0.9, 1);
    expect(a.gone).toBe(true);
    expect(r.x).toBeCloseTo(50 + 5 * 0.985, 3);
  });
});
