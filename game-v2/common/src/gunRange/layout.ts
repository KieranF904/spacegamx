/**
 * @contract common.gun-range.layout
 * owns:       the gun range's chamber (systems.json `gunRange`): its walls as solid terrain pieces, the exit door and the zone
 *             X works in, where a pilot comes in, and where the target stands
 * needs:      terrain.ts (TerrainFile), ships/types (Vec2), math/detTrig
 * invariants: the walls close the chamber all round, and the door zone, the spawn and the target spot are inside it —
 *             common/src/gunRange/layout.test.ts
 *             the server's terrain (data/GameData.ts) and the client's (rendering/terrainData.ts) take the same walls from
 *             the same def — common/src/gunRange/layout.test.ts
 * extend:     a new thing in the chamber is a field of GunRangeDef and a line in chamberWalls / the door helpers here
 *
 * The gun range (server game/gunRange) is one shared indoor chamber on a station: a rectangle of open floor with a solid
 * wall all round it (terrain `walls`, so collideTerrain, rayTerrain and insideTerrain stop ships and shots at it on the
 * server and in every client's prediction alike, with no check of its own), the exit door in one wall, and one big target
 * at the far end. The door is part of the wall (closed): a pilot leaves by flying up to it and pressing interact.
 * Pure and deterministic: plain arithmetic on the def's numbers, so every engine builds the same bits.
 */

import type { Vec2 } from '../ships/types.js';
import type { TerrainFile } from '../terrain.js';
import { dhypot } from '../math/detTrig.js';

export type RangeWall = 'N' | 'E' | 'S' | 'W';

/** The target the range keeps standing (an enemy design, data/ships/blueprints/enemy): never fires, pays nothing */
export interface GunRangeTargetDef {
  /** Enemy design id (data/ships/blueprints/enemy), its faction (factions.json) and Mk grade */
  ship: string;
  faction: string;
  grade?: number;
  /** Where it stands (world units) and the way it faces (radians) */
  x: number;
  y: number;
  angle: number;
  /** Seconds after it is destroyed that it comes back whole */
  respawnSeconds: number;
  /** Pushed further than this from its spot, it flies itself back (its autopilot, as the clients replay it) */
  keepRadius: number;
}

/** systems.json `gunRange`: the chamber, its door, the spawn and the target */
export interface GunRangeDef {
  /** The chamber's open floor: a rectangle `width` x `height` centred on `centre` */
  centre: { x: number; y: number };
  width: number;
  height: number;
  /** How thick the wall round it is (thick enough that nothing passes through it in a tick) */
  wall: number;
  /** The exit door: which wall it is in, how far along it from that wall's middle (+ is east or south), its width, and how near X works */
  door: { wall: RangeWall; along?: number; width: number; reach: number };
  /** Where a pilot comes in (just inside the door), facing `angle` (radians) */
  spawn: { x: number; y: number; angle: number };
  target: GunRangeTargetDef;
}

/** The inner rectangle's edges */
export function chamberBox(d: GunRangeDef): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: d.centre.x - d.width / 2, y0: d.centre.y - d.height / 2, x1: d.centre.x + d.width / 2, y1: d.centre.y + d.height / 2 };
}

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** The wall's solid pieces (four rectangles that overlap at the corners, so there is no seam to slip through) */
export function chamberWalls(d: GunRangeDef): Vec2[][] {
  const { x0, y0, x1, y1 } = chamberBox(d), t = d.wall;
  return [
    rect(x0 - t, y0 - t, x1 + t, y0), // north
    rect(x0 - t, y1, x1 + t, y1 + t), // south
    rect(x0 - t, y0 - t, x0, y1 + t), // west
    rect(x1, y0 - t, x1 + t, y1 + t), // east
  ];
}

/** A system's terrain with its gun range's walls in it (undefined: no rock and no range) */
export function withGunRange(file: TerrainFile | undefined, d: GunRangeDef | undefined): TerrainFile | undefined {
  if (!d) return file;
  return { ...(file ?? { rocks: [] }), walls: [...(file?.walls ?? []), ...chamberWalls(d)] };
}

/** The door: the middle of its face on the inside of the wall, the way into the chamber from it, and its two ends */
export function rangeDoor(d: GunRangeDef): { x: number; y: number; nx: number; ny: number; ends: [Vec2, Vec2] } {
  const { x0, y0, x1, y1 } = chamberBox(d), a = d.door.along ?? 0, h = d.door.width / 2;
  switch (d.door.wall) {
    case 'N': return { x: d.centre.x + a, y: y0, nx: 0, ny: 1, ends: [[d.centre.x + a - h, y0], [d.centre.x + a + h, y0]] };
    case 'S': return { x: d.centre.x + a, y: y1, nx: 0, ny: -1, ends: [[d.centre.x + a - h, y1], [d.centre.x + a + h, y1]] };
    case 'E': return { x: x1, y: d.centre.y + a, nx: -1, ny: 0, ends: [[x1, d.centre.y + a - h], [x1, d.centre.y + a + h]] };
    default: return { x: x0, y: d.centre.y + a, nx: 1, ny: 0, ends: [[x0, d.centre.y + a - h], [x0, d.centre.y + a + h]] };
  }
}

/** Is a ship at (x, y) near enough the door for X to take it out (the server decides; the client shows the prompt by the same rule) */
export function atRangeDoor(d: GunRangeDef, x: number, y: number): boolean {
  const door = rangeDoor(d);
  return dhypot(x - door.x, y - door.y) <= d.door.reach;
}

/** Is (x, y) on the chamber's open floor, `margin` clear of the walls */
export function insideChamber(d: GunRangeDef, x: number, y: number, margin = 0): boolean {
  const { x0, y0, x1, y1 } = chamberBox(d);
  return x > x0 + margin && x < x1 - margin && y > y0 + margin && y < y1 - margin;
}
