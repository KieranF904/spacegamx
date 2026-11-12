/**
 * @contract common.gun-range.layout
 * owns:       the gun range's rooms (systems.json `gunRange.rooms`): each a chamber with its walls as solid terrain pieces,
 *             its doors (the exit, and the ones through to other rooms) and the zones X works in, where a pilot comes in
 *             or arrives through a door, and where the targets stand
 * needs:      terrain.ts (TerrainFile), ships/types (Vec2), math/detTrig
 * invariants: each room's walls close it all round (a door is no gap in them), and its door zones, spawn and target spots
 *             are inside it; the rooms stand well apart (none in sight or reach of another); every room has one exit, and
 *             a door through to a room has one back from it — common/src/gunRange/layout.test.ts
 *             the server's terrain (data/GameData.ts) and the client's (rendering/terrainData.ts) take the same walls from
 *             the same def — common/src/gunRange/layout.test.ts
 * extend:     a new room is an entry of systems.json `gunRange.rooms` (nothing here names one); a new thing in a room is
 *             a field of GunRangeRoomDef and a line in chamberWalls / the door helpers here; a new door is an entry of
 *             a room's `doors` (`to`: 'exit' or a room's id)
 *
 * The gun range (server game/gunRange) is a few indoor rooms on a station, in one private system, far apart: each a
 * rectangle of open floor with a solid wall all round it (terrain `walls`, so collideTerrain, rayTerrain and insideTerrain
 * stop ships and shots at it on the server and in every client's prediction alike, with no check of its own), the exit
 * door in one wall, a door through to the next room in the wall across from it, and its targets on the floor. A door is
 * part of the wall (closed): a pilot goes through one by flying up to it and pressing interact (the exit: back to their
 * station; any other: to just inside the door of that room that leads back). A pilot is in one room at a time (the first
 * on going in).
 * Pure and deterministic: plain arithmetic on the def's numbers, so every engine builds the same bits.
 */

import type { Vec2 } from '../ships/types.js';
import type { TerrainFile } from '../terrain.js';
import { dhypot } from '../math/detTrig.js';

export type RangeWall = 'N' | 'E' | 'S' | 'W';

/**
 * A target a room keeps standing: an enemy design (data/ships/blueprints/enemy: never fires, pays nothing), or a mob
 * (data/mobs.json: one that sits where it is laid)
 */
export interface GunRangeTargetDef {
  /** What the floor and the HUD call it ("Drone · weak") */
  label: string;
  /** Enemy design id (data/ships/blueprints/enemy), its faction (factions.json) and Mk grade */
  ship?: string;
  faction?: string;
  grade?: number;
  /** Instead of a ship: a mob kind (data/mobs.json) laid at the spot */
  mob?: string;
  /** Its parts' HP as a share of the design's (the way a boss's hull is scaled): below 1 is a soft target */
  hp?: number;
  /** The radius of the rings drawn round its spot on the floor (world units); 0: no mark of its own (one of a group) */
  ring: number;
  /** Where it stands (world units) and the way it faces (radians) */
  x: number;
  y: number;
  angle: number;
  /** Seconds after it is destroyed that it comes back whole */
  respawnSeconds: number;
  /** Pushed further than this from its spot, it flies itself back (its autopilot, as the clients replay it) */
  keepRadius: number;
}

/** `to` of the door that leaves the range */
export const RANGE_EXIT = 'exit';

/** A door in a room's wall: shut, a part of the wall; X within `reach` of it takes the pilot where it leads */
export interface RangeDoorDef {
  /** Which wall it is in, and how far along it from that wall's middle (+ is east or south) */
  wall: RangeWall;
  along?: number;
  /** Its width, and how near X works */
  width: number;
  reach: number;
  /** Where it leads: RANGE_EXIT (out of the range, back to the station), or another room's id */
  to: string;
}

/** One room of the range: the chamber, its doors, the spawn and the targets */
export interface GunRangeRoomDef {
  /** What the server and the client call it (gunRangeState.room, a door's `to`), and its name on the doors that lead to it */
  id: string;
  name: string;
  /** How bright it is, of the system's light (1, the default: fully lit; a dark room is well under) */
  light?: number;
  /** The chamber's open floor: a rectangle `width` x `height` centred on `centre` */
  centre: { x: number; y: number };
  width: number;
  height: number;
  /** How thick the wall round it is (thick enough that nothing passes through it in a tick) */
  wall: number;
  /** Its doors: one exit, and the ways through to other rooms (each of those rooms has a door back) */
  doors: RangeDoorDef[];
  /** Where a pilot comes in (just inside the exit door), facing `angle` (radians) */
  spawn: { x: number; y: number; angle: number };
  /** Near to far: each its own ship, never firing, paying nothing, and back whole on its own clock */
  targets: GunRangeTargetDef[];
}

/** systems.json `gunRange`: its rooms, the first the one a pilot comes into */
export interface GunRangeDef {
  rooms: GunRangeRoomDef[];
}

/** A room by id (undefined: no such room) */
export function rangeRoom(d: GunRangeDef, id: string | undefined): GunRangeRoomDef | undefined {
  return d.rooms.find((r) => r.id === id);
}

/** The room whose floor (x, y) is on (undefined: on none) */
export function rangeRoomAt(d: GunRangeDef, x: number, y: number): GunRangeRoomDef | undefined {
  return d.rooms.find((r) => insideChamber(r, x, y));
}

/** The inner rectangle's edges */
export function chamberBox(d: GunRangeRoomDef): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: d.centre.x - d.width / 2, y0: d.centre.y - d.height / 2, x1: d.centre.x + d.width / 2, y1: d.centre.y + d.height / 2 };
}

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** The wall's solid pieces (four rectangles that overlap at the corners, so there is no seam to slip through) */
export function chamberWalls(d: GunRangeRoomDef): Vec2[][] {
  const { x0, y0, x1, y1 } = chamberBox(d), t = d.wall;
  return [
    rect(x0 - t, y0 - t, x1 + t, y0), // north
    rect(x0 - t, y1, x1 + t, y1 + t), // south
    rect(x0 - t, y0 - t, x0, y1 + t), // west
    rect(x1, y0 - t, x1 + t, y1 + t), // east
  ];
}

/** A system's terrain with its gun range's walls in it, every room's (undefined: no rock and no range) */
export function withGunRange(file: TerrainFile | undefined, d: GunRangeDef | undefined): TerrainFile | undefined {
  if (!d) return file;
  return { ...(file ?? { rocks: [] }), walls: [...(file?.walls ?? []), ...d.rooms.flatMap(chamberWalls)] };
}

/** A room's exit door (every room has one: the data's validator and layout.test.ts) */
export function exitDoor(d: GunRangeRoomDef): RangeDoorDef {
  return d.doors.find((x) => x.to === RANGE_EXIT) ?? d.doors[0];
}

/** A room's door through to this room (undefined: none) */
export function doorTo(d: GunRangeRoomDef, to: string): RangeDoorDef | undefined {
  return d.doors.find((x) => x.to === to);
}

/** A door (the exit, unless one is given): the middle of its face on the inside of the wall, the way into the chamber from it, and its two ends */
export function rangeDoor(d: GunRangeRoomDef, door: RangeDoorDef = exitDoor(d)): { x: number; y: number; nx: number; ny: number; ends: [Vec2, Vec2] } {
  const { x0, y0, x1, y1 } = chamberBox(d), a = door.along ?? 0, h = door.width / 2;
  switch (door.wall) {
    case 'N': return { x: d.centre.x + a, y: y0, nx: 0, ny: 1, ends: [[d.centre.x + a - h, y0], [d.centre.x + a + h, y0]] };
    case 'S': return { x: d.centre.x + a, y: y1, nx: 0, ny: -1, ends: [[d.centre.x + a - h, y1], [d.centre.x + a + h, y1]] };
    case 'E': return { x: x1, y: d.centre.y + a, nx: -1, ny: 0, ends: [[x1, d.centre.y + a - h], [x1, d.centre.y + a + h]] };
    default: return { x: x0, y: d.centre.y + a, nx: 1, ny: 0, ends: [[x0, d.centre.y + a - h], [x0, d.centre.y + a + h]] };
  }
}

/**
 * The door a ship at (x, y) is near enough for X to take it through: the nearest of those in reach (undefined: none).
 * The server decides by this; the client shows the prompt by the same rule.
 */
export function rangeDoorAt(d: GunRangeRoomDef, x: number, y: number): RangeDoorDef | undefined {
  let best: RangeDoorDef | undefined, bestD = Infinity;
  for (const door of d.doors) {
    const p = rangeDoor(d, door), dist = dhypot(x - p.x, y - p.y);
    if (dist <= door.reach && dist < bestD) { best = door; bestD = dist; }
  }
  return best;
}

/** How far inside a door a ship that came through it is put (clear of the wall, inside the door's zone) */
export const DOOR_ARRIVAL = 300;

/** Where a ship that came through this door stands: just inside it, facing into the room */
export function doorArrival(d: GunRangeRoomDef, door: RangeDoorDef): { x: number; y: number; angle: number } {
  const p = rangeDoor(d, door);
  // (The walls are square to the axes: the four ways in, as plain numbers, so every engine has the same bits)
  const angle = p.nx > 0 ? 0 : p.nx < 0 ? Math.PI : p.ny > 0 ? Math.PI / 2 : -Math.PI / 2;
  return { x: p.x + p.nx * DOOR_ARRIVAL, y: p.y + p.ny * DOOR_ARRIVAL, angle };
}

/** Is (x, y) on the chamber's open floor, `margin` clear of the walls */
export function insideChamber(d: GunRangeRoomDef, x: number, y: number, margin = 0): boolean {
  const { x0, y0, x1, y1 } = chamberBox(d);
  return x > x0 + margin && x < x1 - margin && y > y0 + margin && y < y1 - margin;
}
