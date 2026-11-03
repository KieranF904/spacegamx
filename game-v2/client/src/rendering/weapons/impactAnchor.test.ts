import { describe, expect, it } from 'vitest';
import { ImpactAnchor } from './impactAnchor';

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
});
