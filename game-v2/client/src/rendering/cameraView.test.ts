import { describe, expect, it } from 'vitest';
import { helmFollow, HELM_FOLLOW_RATE, HELM_TIGHT_RATE, MAX_VIEW_SPIN, HELM_TIGHT_SPIN, noseUpAngle, screenToWorld, smoothAngle, viewHalfExtents, worldToScreen, worldToScreenDir, wrapAngle } from './cameraView';

const PI = Math.PI;

describe('wrapAngle', () => {
  it('keeps angles in [-π, π)', () => {
    expect(wrapAngle(0)).toBeCloseTo(0);
    expect(wrapAngle(3 * PI)).toBeCloseTo(-PI);
    expect(wrapAngle(-3 * PI / 2)).toBeCloseTo(PI / 2);
    expect(wrapAngle(7.5 * PI)).toBeCloseTo(-PI / 2);
    expect(wrapAngle(-0.1)).toBeCloseTo(-0.1);
  });
});

describe('smoothAngle', () => {
  it('goes the short way across ±π', () => {
    const a = smoothAngle(PI - 0.1, -PI + 0.1, 3, 1 / 60);
    // Stepped up past π (wrapping), not back down through 0
    expect(Math.abs(wrapAngle(a - (PI - 0.1)))).toBeLessThan(0.2);
    expect(wrapAngle(a - (PI - 0.1))).toBeGreaterThan(0);
  });

  it('is the same at any frame rate', () => {
    let fast = 0, slow = 0;
    for (let i = 0; i < 144; i++) fast = smoothAngle(fast, 1, 3, 1 / 144);
    for (let i = 0; i < 30; i++) slow = smoothAngle(slow, 1, 3, 1 / 30);
    expect(fast).toBeCloseTo(slow, 6);
    expect(fast).toBeCloseTo(1 - Math.exp(-3), 6);
  });

  it('caps the spin rate', () => {
    const a = smoothAngle(0, PI * 0.9, 50, 0.1, 2);
    expect(a).toBeCloseTo(0.2);
  });

  it('settles on the target and holds still for dt 0', () => {
    let a = 0;
    for (let i = 0; i < 600; i++) a = smoothAngle(a, -2, 3, 1 / 60);
    expect(a).toBeCloseTo(-2, 5);
    expect(smoothAngle(0.4, 1, 3, 0)).toBe(0.4);
  });
});

describe('screen ↔ world with rotation', () => {
  const W = 800, H = 600;

  it('is the plain transform at angle 0', () => {
    const cam = { x: 100, y: -50, zoom: 2, angle: 0 };
    expect(screenToWorld(500, 300, cam, W, H)).toEqual({ x: 150, y: -50 });
  });

  it('puts the heading up the screen', () => {
    // A ship at angle a points its nose along (cos a, sin a)
    for (const a of [0.7, -2.9, Math.PI]) {
      const cam = { x: 0, y: 0, zoom: 1, angle: noseUpAngle(a) };
      const nose = worldToScreenDir(Math.cos(a), Math.sin(a), cam.angle);
      expect(nose.x).toBeCloseTo(0);
      expect(nose.y).toBeCloseTo(-1);
      // and the screen's top-centre lies ahead of the ship
      const p = screenToWorld(W / 2, H / 2 - 100, cam, W, H);
      expect(p.x).toBeCloseTo(Math.cos(a) * 100);
      expect(p.y).toBeCloseTo(Math.sin(a) * 100);
    }
  });

  it('round-trips', () => {
    const cam = { x: 1234, y: -987, zoom: 0.37, angle: -2.1 };
    for (const [sx, sy] of [[0, 0], [800, 600], [123, 456], [400, 300]]) {
      const w = screenToWorld(sx, sy, cam, W, H);
      const s = worldToScreen(w.x, w.y, cam, W, H);
      expect(s.x).toBeCloseTo(sx, 6);
      expect(s.y).toBeCloseTo(sy, 6);
    }
  });

  it('bounds the turned view', () => {
    expect(viewHalfExtents(W, H, 1, 0)).toEqual({ hw: 400, hh: 300 });
    const q = viewHalfExtents(W, H, 2, PI / 2);
    expect(q.hw).toBeCloseTo(150);
    expect(q.hh).toBeCloseTo(200);
    const d = viewHalfExtents(W, H, 1, PI / 4);
    expect(d.hw).toBeCloseTo(700 / Math.SQRT2);
  });
});

describe('helmFollow', () => {
  it('starts loose and tightens to a close (not rigid) follow', () => {
    expect(helmFollow(0)).toEqual({ rate: HELM_FOLLOW_RATE, maxSpin: MAX_VIEW_SPIN });
    const mid = helmFollow(0.6);
    expect(mid.rate).toBeGreaterThan(HELM_FOLLOW_RATE);
    expect(mid.rate).toBeLessThan(HELM_TIGHT_RATE);
    expect(helmFollow(5)).toEqual({ rate: HELM_TIGHT_RATE, maxSpin: HELM_TIGHT_SPIN });
    // Settled, a ship turning steadily is followed with only a small lag
    let cam = 0, ship = 0;
    const { rate, maxSpin } = helmFollow(5);
    for (let i = 0; i < 240; i++) { ship += 2 / 60; cam = smoothAngle(cam, ship, rate, 1 / 60, maxSpin); }
    const lag = Math.abs(wrapAngle(ship - cam));
    expect(lag).toBeGreaterThan(0.05);
    expect(lag).toBeLessThan(0.25);
  });
});
