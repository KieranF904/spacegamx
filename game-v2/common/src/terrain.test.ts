import { describe, it, expect } from 'vitest';
import { buildTerrain, collideTerrain, collideTerrainHull, rayTerrain, insideTerrain, terrainRadius } from './terrain.js';
import type { ShipHull } from './ships/contact.js';

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

  describe('a ship against rock by its hull (collideTerrainHull), never a circle', () => {
    /** Squares (side 40) at these body-frame centres, as a hull: one piece each */
    const hullOf = (cells: [number, number][]): ShipHull => {
      const pts: number[] = [];
      for (const [x, y] of cells) pts.push(x - 20, y - 20, x + 20, y - 20, x + 20, y + 20, x - 20, y + 20);
      return { pts: Float64Array.from(pts), n: Int32Array.from(cells.map(() => 4)) };
    };
    // A U opening up (-y): its bar along y 0, arms up to y -320 at x -160 and 160; and a spar out to x 520 along y 0
    const cells: [number, number][] = [];
    for (let x = -160; x <= 160; x += 40) cells.push([x, 0]);
    for (let y = -40; y >= -320; y -= 40) { cells.push([-160, y]); cells.push([160, y]); }
    for (let x = 200; x <= 520; x += 40) cells.push([x, 0]);
    const U = hullOf(cells);
    const R = Math.max(...cells.map(([x, y]) => Math.hypot(Math.abs(x) + 20, Math.abs(y) + 20)));
    // (angle -pi/2: the body frame is the world's, turned not at all)
    const FLAT = -Math.PI / 2;

    it("a pillar in its concave gap touches nothing (a circle of most of its reach would have hit it)", () => {
      const t = buildTerrain({ rocks: [[[-30, -250], [30, -250], [30, -150], [-30, -150]]] });
      const body = { x: 0, y: 0, vx: 2, vy: -1, angle: FLAT };
      expect(collideTerrainHull(body, U, R, t)).toBe(false);
      expect(body).toEqual({ x: 0, y: 0, vx: 2, vy: -1, angle: FLAT });
      expect(collideTerrain({ x: 0, y: 0, vx: 0, vy: 0 }, terrainRadius(R), t)).toBe(true);
    });

    it('its thin spar reaching into a wall is pushed out, by the spar alone', () => {
      // (The wall's face at x 530: the spar's tip reaches 540, 10 in; the circle of most of its reach falls well short)
      const t = buildTerrain({ rocks: [[[530, -400], [900, -400], [900, 400], [530, 400]]] });
      expect(collideTerrain({ x: 0, y: 0, vx: 0, vy: 0 }, terrainRadius(R), t)).toBe(false);
      const body = { x: 0, y: 0, vx: 3, vy: 0.5, angle: FLAT };
      expect(collideTerrainHull(body, U, R, t)).toBe(true);
      expect(body.x).toBeCloseTo(-10, 6);
      expect(body.y).toBe(0);
      expect(body.vx).toBeLessThanOrEqual(0);
      expect(body.vy).toBe(0.5);
      // Turned so the spar points away, the same place is clear
      const turned = { x: 0, y: 0, vx: 3, vy: 0, angle: FLAT + Math.PI };
      expect(collideTerrainHull(turned, U, R, t)).toBe(false);
    });

    it('pressed into a face made of several pieces (triangles side by side), it comes out along the face, not across a seam', () => {
      // (The rock mass as triangles meeting along their diagonals: the seams run into the rock)
      const t = buildTerrain({ rocks: [], mass: [[[-600, 30], [600, 30], [600, 400]], [[-600, 30], [600, 400], [-600, 400]], [[600, 30], [1200, 30], [1200, 400]], [[600, 30], [1200, 400], [600, 400]]] });
      for (const x of [0, 400, 590, 610]) {
        const body = { x, y: 20, vx: 0, vy: 6, angle: FLAT };
        expect(collideTerrainHull(body, U, R, t)).toBe(true);
        // (its bar's underside at y 40 was 10 into the face at y 30: pushed straight back up to it)
        expect(body.y).toBeCloseTo(10, 6);
        expect(body.x).toBe(x);
        expect(body.vy).toBeLessThanOrEqual(0);
      }
      // (Blocks side by side, the seam between them square to the face at y 530: the spar turned to point down, its tip
      // alone 10 into the face and straddling the seam by 5, comes straight up, not 5 sideways across the seam)
      const blocks = buildTerrain({ rocks: [], mass: [[[0, 530], [600, 530], [600, 900], [0, 900]], [[600, 530], [1200, 530], [1200, 900], [600, 900]]] });
      for (const x of [585, 615]) {
        const body = { x, y: 0, vx: 0, vy: 6, angle: 0 };
        expect(collideTerrainHull(body, U, R, blocks)).toBe(true);
        expect(body.y).toBeCloseTo(-10, 6);
        expect(body.x).toBe(x);
      }
    });
  });
});
