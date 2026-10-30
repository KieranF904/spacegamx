import { describe, it, expect } from 'vitest';
import { buildTerrain, collideTerrain, rayTerrain, insideTerrain } from './terrain.js';

// A square rock 1000 across at the origin, and a concave L-shaped one off to the side
const terrain = buildTerrain({
  rocks: [
    [[-500, -500], [500, -500], [500, 500], [-500, 500]],
    [[3000, 0], [5000, 0], [5000, 600], [3600, 600], [3600, 2000], [3000, 2000]],
  ],
});

describe('terrain', () => {
  it('pushes a ship out of rock and takes away its speed into it', () => {
    const body = { x: -560, y: 0, vx: 8, vy: 1 };
    expect(collideTerrain(body, 100, terrain)).toBe(true);
    expect(body.x).toBeCloseTo(-600, 6);
    expect(body.vx).toBeLessThanOrEqual(0);
    expect(body.vy).toBe(1);
    // Clear of it: untouched
    const far = { x: -2000, y: 0, vx: 8, vy: 0 };
    expect(collideTerrain(far, 100, terrain)).toBe(false);
    expect(far).toEqual({ x: -2000, y: 0, vx: 8, vy: 0 });
  });

  it('pushes a ship that ends up inside out by the nearest face', () => {
    const body = { x: 0, y: 450, vx: 0, vy: -5 };
    collideTerrain(body, 80, terrain);
    expect(body.y).toBeCloseTo(580, 6);
    expect(insideTerrain(terrain, body.x, body.y, 79)).toBe(false);
  });

  it('stops rays where they meet rock, the concave rock too, and lets clear ones by', () => {
    expect(rayTerrain(terrain, -2000, 0, 0, 0)).toBeCloseTo(0.75, 6);
    expect(rayTerrain(terrain, -2000, 2000, 2000, 2000)).toBe(1);
    // Into the L's inner corner: the arm is in the way
    expect(rayTerrain(terrain, 4300, 1500, 4300, 0)).toBeCloseTo((1500 - 600) / 1500, 6);
    expect(insideTerrain(terrain, 3300, 1500)).toBe(true);
    expect(insideTerrain(terrain, 4300, 1500)).toBe(false);
  });
});
