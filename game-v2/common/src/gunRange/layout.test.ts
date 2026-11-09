/** The gun range's chamber (layout.ts): closed walls that stop ships and shots alike, the door zone, and the real data's chamber. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildTerrain, collideTerrain, insideTerrain, rayTerrain } from '../terrain.js';
import { atRangeDoor, chamberBox, chamberWalls, insideChamber, rangeDoor, withGunRange, type GunRangeDef } from './layout.js';

const systems = JSON.parse(readFileSync(join(__dirname, '../../../data/systems.json'), 'utf8')) as { systems: { id: string; private?: boolean; gunRange?: GunRangeDef }[] };
const ranges = systems.systems.filter((s) => s.gunRange);
const def = ranges[0]?.gunRange as GunRangeDef;

describe('gun range layout', () => {
  it('the game has exactly one gun range, private', () => {
    expect(ranges.map((s) => s.id)).toEqual(['gun_range']);
    expect(ranges[0].private).toBe(true);
  });

  it('the spawn, the target and the door zone are on the chamber floor, clear of the walls', () => {
    expect(insideChamber(def, def.spawn.x, def.spawn.y, 100)).toBe(true);
    expect(insideChamber(def, def.target.x, def.target.y, 100)).toBe(true);
    const d = rangeDoor(def);
    // (A ship just inside the door is at it; the spawn is near enough to see it, not on it)
    expect(atRangeDoor(def, d.x + d.nx * 150, d.y + d.ny * 150)).toBe(true);
    expect(atRangeDoor(def, def.target.x, def.target.y)).toBe(false);
    expect(Math.hypot(def.spawn.x - d.x, def.spawn.y - d.y)).toBeLessThan(800);
  });

  it('the walls are solid all round: no ship gets out, no shot either, from anywhere inside', () => {
    const t = buildTerrain(withGunRange(undefined, def)!);
    const { x0, y0, x1, y1 } = chamberBox(def);
    // Shots: from the middle, every way, stopped short of the far side of the wall
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2, L = 20000;
      const f = rayTerrain(t, def.centre.x, def.centre.y, def.centre.x + Math.cos(a) * L, def.centre.y + Math.sin(a) * L);
      expect(f).toBeLessThan(1);
    }
    // Ships: one driven at each wall, fast, ends up inside
    for (const [vx, vy] of [[60, 0], [-60, 0], [0, 60], [0, -60], [45, 45]]) {
      const b = { x: def.centre.x, y: def.centre.y, vx, vy };
      for (let i = 0; i < 400; i++) { b.x += b.vx; b.y += b.vy; collideTerrain(b, 40, t); }
      expect(b.x > x0 - 1 && b.x < x1 + 1 && b.y > y0 - 1 && b.y < y1 + 1).toBe(true);
    }
    // Inside is open floor; the wall is solid
    expect(insideTerrain(t, def.centre.x, def.centre.y)).toBe(false);
    expect(insideTerrain(t, x0 - def.wall / 2, def.centre.y)).toBe(true);
  });

  it('keeps any terrain the system already has, and builds the same pieces every time', () => {
    const file = withGunRange({ rocks: [[[0, 0], [10, 0], [10, 10]]] }, def)!;
    expect(file.rocks.length).toBe(1);
    expect(file.walls).toEqual(chamberWalls(def));
    expect(JSON.stringify(chamberWalls(def))).toBe(JSON.stringify(chamberWalls(def)));
    expect(withGunRange(undefined, undefined)).toBeUndefined();
  });
});
