import { describe, it, expect } from 'vitest';
import { CLAMP, clampWorld, clampFit, clampLinedUp, clampOffset, followerPose, pairKey, type ClampBody } from './clamp.js';

const CS = 24;
// Leader: clamp on its right side (grid +x), COM at the origin. Follower: clamp on its front (grid -y), COM 1 cell behind it
const lc = { part: 0, uid: 1, size: 1, mouth: [1, 0] as [number, number], dir: [1, 0] as [number, number] };
const fc = { part: 0, uid: 2, size: 1, mouth: [0, -1] as [number, number], dir: [0, -1] as [number, number] };
const lcom: [number, number] = [0, 0], fcom: [number, number] = [0, 0.5];

describe('docking clamps', () => {
  it('the locked follower sits mouth to mouth, facing the leader, at any leader pose', () => {
    const o = clampOffset(lc, lcom, fc, fcom, CS);
    for (const leader of [
      { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 },
      { x: 500, y: -300, vx: 3, vy: -1, angle: 2.1, angVel: 0.01 },
    ] as ClampBody[]) {
      const f = followerPose(leader, o);
      const a = clampWorld(lc, lcom, CS, leader), b = clampWorld(fc, fcom, CS, f);
      expect(Math.abs(a.x - b.x)).toBeLessThan(0.05);
      expect(Math.abs(a.y - b.y)).toBeLessThan(0.05);
      expect(Math.abs(a.nx + b.nx)).toBeLessThan(1e-3);
      expect(Math.abs(a.ny + b.ny)).toBeLessThan(1e-3);
      const fit = clampFit(a, b);
      expect(clampLinedUp(fit, leader, f)).toBe(true);
    }
  });

  it('lined up within the tolerances only: gap, sideways, angle, and moving together', () => {
    const lead: ClampBody = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 };
    const o = clampOffset(lc, lcom, fc, fcom, CS);
    const f = followerPose(lead, o);
    const a = clampWorld(lc, lcom, CS, lead);
    // (moved along the leader clamp's way out by `out` and across it by `side`)
    const shifted = (out: number, side: number, da = 0, dv = 0): boolean => {
      const g = { ...f, x: f.x + a.nx * out - a.ny * side, y: f.y + a.ny * out + a.nx * side, angle: f.angle + da, vx: f.vx + dv };
      return clampLinedUp(clampFit(a, clampWorld(fc, fcom, CS, g)), lead, g);
    };
    expect(shifted(0, 0)).toBe(true);
    expect(shifted(CLAMP.reach - 2, 0)).toBe(true);
    expect(shifted(CLAMP.reach + 2, 0)).toBe(false);
    expect(shifted(0, CLAMP.lateral + 2)).toBe(false);
    expect(shifted(0, 0, CLAMP.angle + 0.02)).toBe(false);
    expect(shifted(0, 0, 0, CLAMP.speed + 0.5)).toBe(false);
    // (the prompt's slack lets a little more through)
    const g = { ...f, x: f.x - a.ny * (CLAMP.lateral + 2), y: f.y + a.nx * (CLAMP.lateral + 2) };
    expect(clampLinedUp(clampFit(a, clampWorld(fc, fcom, CS, g)), lead, g, CLAMP.promptSlack)).toBe(true);
  });

  it('pair keys are order-free', () => {
    expect(pairKey(5, 9)).toBe(pairKey(9, 5));
  });
});
