/** The gun range's chamber (layout.ts): closed walls that stop ships and shots alike, the door zone, and the real data's chamber. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildTerrain, collideTerrain, insideTerrain, rayTerrain } from '../terrain.js';
import { atRangeDoor, chamberBox, chamberWalls, insideChamber, rangeDoor, withGunRange, type GunRangeDef } from './layout.js';

const systems = JSON.parse(readFileSync(join(__dirname, '../../../data/systems.json'), 'utf8')) as { systems: { id: string; private?: boolean; gunRange?: GunRangeDef }[] };
const ranges = systems.systems.filter((s) => s.gunRange);
const def = ranges[0]?.gunRange as GunRangeDef;
const heavy = def.targets.find((t) => t.ship === 'giant_mammoth')!;

describe('gun range layout', () => {
  it('the game has exactly one gun range, private', () => {
    expect(ranges.map((s) => s.id)).toEqual(['gun_range']);
    expect(ranges[0].private).toBe(true);
  });

  it('the spawn, every target and the door zone are on the chamber floor, clear of the walls', () => {
    expect(insideChamber(def, def.spawn.x, def.spawn.y, 100)).toBe(true);
    for (const t of def.targets) expect(insideChamber(def, t.x, t.y, t.ring + 100), t.label).toBe(true);
    const d = rangeDoor(def);
    // (A ship just inside the door is at it; the spawn is near enough to see it, not on it)
    expect(atRangeDoor(def, d.x + d.nx * 150, d.y + d.ny * 150)).toBe(true);
    for (const t of def.targets) expect(atRangeDoor(def, t.x, t.y), t.label).toBe(false);
    expect(Math.hypot(def.spawn.x - d.x, def.spawn.y - d.y)).toBeLessThan(800);
  });

  it('the targets are spread near to far, clear of each other, the door lane and the spawn', () => {
    const d = rangeDoor(def), lane = 400;
    expect(def.targets.length).toBeGreaterThanOrEqual(5);
    const dist = def.targets.map((t) => Math.hypot(t.x - def.spawn.x, t.y - def.spawn.y));
    expect(Math.min(...dist)).toBeLessThan(2000);
    expect(Math.max(...dist)).toBeGreaterThan(4000);
    def.targets.forEach((a, i) => {
      // (Nothing within the lane's edge of the spawn-to-door line, in front of the spawn)
      expect(Math.hypot(a.x - def.spawn.x, a.y - def.spawn.y), a.label).toBeGreaterThan(a.ring + 600);
      expect(Math.hypot(a.x - d.x, a.y - d.y), a.label).toBeGreaterThan(a.ring + def.door.reach);
      for (const b of def.targets.slice(i + 1)) expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.label} / ${b.label}`).toBeGreaterThan(a.ring + b.ring);
      // (The straight lane from the spawn to the heaviest target stays open)
      if (a !== heavy) expect(Math.abs(a.y - heavy.y), a.label).toBeGreaterThan(lane + a.ring * 0.3);
    });
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
