/** The gun range's rooms (layout.ts): closed walls that stop ships and shots alike, the doors (the exit, and the way through to the other room) and their zones, and the real data's rooms. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildTerrain, collideTerrain, insideTerrain, rayTerrain } from '../terrain.js';
import { RANGE_EXIT, chamberBox, chamberWalls, doorArrival, doorTo, exitDoor, insideChamber, rangeDoor, rangeDoorAt, rangeRoom, rangeRoomAt, withGunRange, type GunRangeDef } from './layout.js';

const data = (name: string) => JSON.parse(readFileSync(join(__dirname, '../../../data', name), 'utf8'));
const systems = data('systems.json') as { systems: { id: string; private?: boolean; gunRange?: GunRangeDef }[] };
const mobs = data('mobs.json').mobs as Record<string, { behaviour: string; speed: number }>;
const ranges = systems.systems.filter((s) => s.gunRange);
const def = ranges[0]?.gunRange as GunRangeDef;
const [first, dark] = def.rooms;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('gun range layout', () => {
  it('the game has exactly one gun range, private, of two rooms: the targets and the dark room', () => {
    expect(ranges.map((s) => s.id)).toEqual(['gun_range']);
    expect(ranges[0].private).toBe(true);
    expect(def.rooms.map((r) => [r.id, r.name])).toEqual([['targets', 'Targets'], ['dark', 'Dark room']]);
    expect(rangeRoom(def, 'dark')).toBe(dark);
    expect(rangeRoom(def, 'nowhere')).toBeUndefined();
    // (Twice the first range's 6000 x 3200 floor each way, both rooms alike; the dark room is the dim one)
    for (const r of def.rooms) expect([r.width, r.height], r.id).toEqual([12000, 6400]);
    expect(first.light ?? 1).toBe(1);
    expect(dark.light).toBeLessThan(0.5);
    expect(dark.light).toBeGreaterThan(0);
  });

  it('the rooms stand far apart: no floor, wall or target of one is anywhere near another', () => {
    def.rooms.forEach((a, i) => {
      const A = chamberBox(a);
      expect(rangeRoomAt(def, a.spawn.x, a.spawn.y)).toBe(a);
      for (const b of def.rooms.slice(i + 1)) {
        const B = chamberBox(b);
        const gap = Math.max(B.x0 - A.x1, A.x0 - B.x1, B.y0 - A.y1, A.y0 - B.y1) - a.wall - b.wall;
        expect(gap, `${a.id} / ${b.id}`).toBeGreaterThan(20000);
      }
    });
    expect(rangeRoomAt(def, first.centre.x, (first.centre.y + dark.centre.y) / 2)).toBeUndefined();
  });

  it('every room has one exit and, in the wall across from it, a door through to the other room, which has one back', () => {
    const ACROSS = { N: 'S', S: 'N', E: 'W', W: 'E' } as const;
    for (const r of def.rooms) {
      const exit = exitDoor(r), box = chamberBox(r);
      expect(r.doors.filter((x) => x.to === RANGE_EXIT), r.id).toEqual([exit]);
      expect(r.doors, r.id).toHaveLength(2);
      for (const door of r.doors) {
        const what = `${r.id} -> ${door.to}`, p = rangeDoor(r, door);
        // (On the wall's inner face, the whole of it within the wall's run, clear of the corners)
        for (const [ex, ey] of [...p.ends, [p.x, p.y]]) {
          expect(ex >= box.x0 && ex <= box.x1 && ey >= box.y0 && ey <= box.y1, what).toBe(true);
          expect(ex === box.x0 || ex === box.x1 || ey === box.y0 || ey === box.y1, what).toBe(true);
        }
        for (const [ex, ey] of p.ends) expect(Math.min(Math.hypot(ex - box.x0, ey - box.y0), Math.hypot(ex - box.x1, ey - box.y0), Math.hypot(ex - box.x0, ey - box.y1), Math.hypot(ex - box.x1, ey - box.y1)), what).toBeGreaterThan(door.reach);
        expect(door.width, what).toBeGreaterThan(0);
        // (A ship just inside it is at it, and at no other; the zones of two doors never meet)
        expect(rangeDoorAt(r, p.x + p.nx * 150, p.y + p.ny * 150), what).toBe(door);
        expect(rangeDoorAt(r, p.x + p.nx * (door.reach - 5), p.y + p.ny * (door.reach - 5)), what).toBe(door);
        expect(rangeDoorAt(r, p.x + p.nx * (door.reach + 5), p.y + p.ny * (door.reach + 5)), what).toBeUndefined();
        for (const o of r.doors) if (o !== door) { const q = rangeDoor(r, o); expect(Math.hypot(p.x - q.x, p.y - q.y), what).toBeGreaterThan(door.reach + o.reach + 1000); }
        if (door === exit) continue;
        // (The way through: across from the exit, the exit's size, to another room that has a door back, alike)
        expect(door.wall, what).toBe(ACROSS[exit.wall]);
        expect([door.width, door.reach], what).toEqual([exit.width, exit.reach]);
        const other = rangeRoom(def, door.to)!;
        expect(other, what).toBeDefined();
        expect(other, what).not.toBe(r);
        const back = doorTo(other, r.id)!;
        expect(back, what).toBeDefined();
        expect(back.wall, what).toBe(ACROSS[exitDoor(other).wall]);
        // (Coming through it, a ship stands just inside it on the floor, in its zone, facing into the room)
        const a = doorArrival(r, door);
        expect(insideChamber(r, a.x, a.y, 200), what).toBe(true);
        expect(rangeDoorAt(r, a.x, a.y), what).toBe(door);
        expect(Math.cos(a.angle) * p.nx + Math.sin(a.angle) * p.ny, what).toBeCloseTo(1, 9);
        expect(Math.hypot(a.x - r.spawn.x, a.y - r.spawn.y), what).toBeGreaterThan(5000);
      }
    }
    // (The targets room leads to the dark room, and back)
    expect(doorTo(first, 'dark')).toBeDefined();
    expect(doorTo(dark, 'targets')).toBeDefined();
    expect(doorTo(first, 'targets')).toBeUndefined();
  });

  it('in every room the spawn, every target and the door zones are on the floor, clear of the walls and of each other', () => {
    for (const r of def.rooms) {
      expect(insideChamber(r, r.spawn.x, r.spawn.y, 100), r.id).toBe(true);
      expect(r.targets.length, r.id).toBeGreaterThan(0);
      const d = rangeDoor(r);
      // (The spawn is near enough the exit to see it, not on it or any door)
      expect(rangeDoorAt(r, r.spawn.x, r.spawn.y)).toBeUndefined();
      expect(Math.hypot(r.spawn.x - d.x, r.spawn.y - d.y)).toBeLessThan(800);
      for (const t of r.targets) {
        const what = `${r.id}: ${t.label}`;
        expect(insideChamber(r, t.x, t.y, t.ring + 100), what).toBe(true);
        expect(rangeDoorAt(r, t.x, t.y), what).toBeUndefined();
        expect(dist(t, r.spawn), what).toBeGreaterThan(t.ring + 600);
        // (Clear of every door's zone, with room to fly up to it; and of where a ship comes through one)
        for (const door of r.doors) {
          expect(dist(t, rangeDoor(r, door)), what).toBeGreaterThan(t.ring + door.reach + 400);
          expect(dist(t, doorArrival(r, door)), what).toBeGreaterThan(t.ring + 600);
        }
        // (A target is a ship of a faction, or a mob that sits where it is laid: one of the two)
        expect(!!t.mob, what).toBe(!t.ship);
        if (t.ship) expect(t.faction, what).toBeTruthy();
        if (t.mob) { expect(mobs[t.mob], what).toBeDefined(); expect(mobs[t.mob].speed, what).toBe(0); }
        expect(t.respawnSeconds, what).toBeGreaterThan(0);
      }
    }
  });

  it('the targets room: near drones, mob targets, three hulls in a line down-range, a tight cluster, the heavies, and a far one on the open centre lane', () => {
    const ts = first.targets, by = (re: RegExp) => ts.filter((t) => re.test(t.label));
    const far = ts.reduce((a, b) => (dist(a, first.spawn) > dist(b, first.spawn) ? a : b));
    expect(Math.min(...ts.map((t) => dist(t, first.spawn)))).toBeLessThan(2000);
    expect(dist(far, first.spawn)).toBeGreaterThan(9000);
    expect(by(/^Drone/).length).toBeGreaterThanOrEqual(2);
    expect(by(/^Hulk/).length).toBe(1);
    expect(by(/^Mammoth/).map((t) => t.ship)).toEqual(['giant_mammoth']);
    const mobTargets = ts.filter((t) => t.mob);
    expect(mobTargets.length).toBeGreaterThanOrEqual(1);
    expect(mobTargets.length).toBeLessThanOrEqual(2);
    // The line: three of one hull on one line away from the door, evenly spaced, so one shot down it meets all three
    const line = by(/^Line/);
    expect(line).toHaveLength(3);
    expect(new Set(line.map((t) => t.ship)).size).toBe(1);
    expect(new Set(line.map((t) => t.y)).size).toBe(1);
    expect(line[1].x - line[0].x).toBeGreaterThan(300);
    expect(line[2].x - line[1].x).toBe(line[1].x - line[0].x);
    expect(line[0].x).toBeGreaterThan(first.spawn.x + 1500);
    // The cluster: four or more within a blast's reach of the middle one, which carries the group's one mark
    const cluster = by(/^Cluster/);
    expect(cluster.length).toBeGreaterThanOrEqual(4);
    expect(cluster.filter((t) => t.ring > 0)).toHaveLength(1);
    const mid = cluster.find((t) => t.ring > 0)!;
    for (const t of cluster) { expect(dist(t, mid)).toBeLessThan(260); expect(dist(t, mid)).toBeLessThan(mid.ring); }
    // Marked spots keep clear of each other (a group's unmarked members stand inside its mark)
    const marked = ts.filter((t) => t.ring > 0);
    marked.forEach((a, i) => { for (const b of marked.slice(i + 1)) expect(dist(a, b), `${a.label} / ${b.label}`).toBeGreaterThan(Math.max(a.ring, b.ring)); });
    for (const t of ts.filter((x) => x.ring === 0)) expect(cluster.includes(t), t.label).toBe(true);
    // The far one is straight down the room from the spawn, and nothing stands in that lane
    expect(far.y).toBe(first.spawn.y);
    for (const t of ts) if (t !== far) expect(Math.abs(t.y - far.y), t.label).toBeGreaterThan(300);
  });

  it('the dark room: a crowd of a dozen and more small hulls of several kinds, packed close in one knot, a short flight from the door in', () => {
    const ts = dark.targets;
    const inAt = doorArrival(dark, doorTo(dark, 'targets')!);
    for (const t of ts) { expect(dist(t, inAt), t.label).toBeLessThan(4000); expect(dist(t, inAt), t.label).toBeGreaterThan(1500); }
    expect(ts.length).toBeGreaterThanOrEqual(12);
    expect(ts.every((t) => t.ship && !t.mob)).toBe(true);
    expect(new Set(ts.map((t) => t.ship)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(ts.map((t) => t.faction)).size).toBeGreaterThanOrEqual(4);
    expect(ts.filter((t) => t.ring > 0)).toHaveLength(1);
    const cx = ts.reduce((s, t) => s + t.x, 0) / ts.length, cy = ts.reduce((s, t) => s + t.y, 0) / ts.length;
    for (const t of ts) expect(dist(t, { x: cx, y: cy }), t.label).toBeLessThan(500);
    // (Each has a neighbour a chain can reach, and none stands on another: the hulls' own sizes are checked where they
    // are built, server/src/game/gunRange/rooms.test.ts)
    ts.forEach((a, i) => {
      const others = ts.filter((_, j) => j !== i).map((b) => dist(a, b));
      expect(Math.min(...others), `crowd ${i}`).toBeLessThan(220);
      expect(Math.min(...others), `crowd ${i}`).toBeGreaterThanOrEqual(140);
    });
  });

  it('the walls of every room are solid all round: no ship gets out, no shot either, from anywhere inside', () => {
    const t = buildTerrain(withGunRange(undefined, def)!);
    for (const r of def.rooms) {
      const { x0, y0, x1, y1 } = chamberBox(r);
      // Shots: from the middle, every way, stopped short of the far side of the wall
      for (let k = 0; k < 64; k++) {
        const a = (k / 64) * Math.PI * 2, L = 20000;
        const f = rayTerrain(t, r.centre.x, r.centre.y, r.centre.x + Math.cos(a) * L, r.centre.y + Math.sin(a) * L);
        expect(f, r.id).toBeLessThan(1);
        expect(Math.hypot(Math.cos(a) * L * f, Math.sin(a) * L * f), r.id).toBeLessThan(Math.hypot(r.width, r.height) / 2 + 1);
      }
      // Ships: one driven at each wall, fast, ends up inside
      for (const [vx, vy] of [[60, 0], [-60, 0], [0, 60], [0, -60], [45, 45]]) {
        const b = { x: r.centre.x, y: r.centre.y, vx, vy };
        for (let i = 0; i < 400; i++) { b.x += b.vx; b.y += b.vy; collideTerrain(b, 40, t); }
        expect(b.x > x0 - 1 && b.x < x1 + 1 && b.y > y0 - 1 && b.y < y1 + 1, r.id).toBe(true);
      }
      // Inside is open floor; the wall is solid
      expect(insideTerrain(t, r.centre.x, r.centre.y)).toBe(false);
      expect(insideTerrain(t, r.spawn.x, r.spawn.y)).toBe(false);
      expect(insideTerrain(t, x0 - r.wall / 2, r.centre.y)).toBe(true);
    }
  });

  it('keeps any terrain the system already has, and builds the same pieces every time', () => {
    const file = withGunRange({ rocks: [[[0, 0], [10, 0], [10, 10]]] }, def)!;
    expect(file.rocks.length).toBe(1);
    expect(file.walls).toEqual(def.rooms.flatMap(chamberWalls));
    expect(file.walls).toHaveLength(def.rooms.length * 4);
    expect(JSON.stringify(chamberWalls(first))).toBe(JSON.stringify(chamberWalls(first)));
    expect(withGunRange(undefined, undefined)).toBeUndefined();
  });
});
