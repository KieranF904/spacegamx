/**
 * The focus grid (CAPS.FOCUS, protocol 38; docs/design/awareness-model.md section 0): each system is cut into fixed
 * square cells, CELL_SIZE a side, origin at the system's centre. Every ship has one home cell (where it is, changed only
 * once it is CELL_HOME_SLACK past the border). A client's **focus** is every cell whose nearest point is within
 * FOCUS_RANGE of its ship (one flat threshold, no hysteresis, whatever the zoom): the ships homed there are on its tick
 * layer. Its **ring** is every other cell within RING_RANGE: ghosts only (map-dot legs), nothing simulated.
 *
 * A cell leaving the focus is dropped, and the client keeps what it had of it (its replicas, as of the drop's tick) for
 * CELL_HOLD_TICKS. When the cell comes back the server asks for a hash of that (cellMemberHash, cellHash); if it is what
 * the server recorded and the control changes since are smaller than a fresh entry, they go instead (a log) and the
 * client fast-forwards. Nothing here is on a simulation path: it is what is sent, never how anything moves.
 */
import type { FlightBody } from '../ships/flight.js';
import { SHIP_PRECISION } from '../ships/physics.js';
import { dpow } from '../math/detTrig.js';

/** A cell's side (world units): 2^13 */
export const CELL_SIZE = 8192;
/** A cell is in a client's focus when its nearest point is within this of the client's ship */
export const FOCUS_RANGE = 19000;
/** ...and in its ring (ghosts) within this */
export const RING_RANGE = 35000;
/** The client draws ships as ghosts from here out (by distance, drawing only: nothing on the wire depends on it) */
export const GHOST_FADE_FROM = 18000;
/** ...fully a ghost from here */
export const GHOST_FADE_TO = 19000;
/** A ship's home cell changes only once it is this far into the next */
export const CELL_HOME_SLACK = 256;
/** A dropped cell is kept (client) and its re-entry offered (server) for this long (ticks: 10 s) */
export const CELL_HOLD_TICKS = 600;
/** The client fast-forwards a returning cell at most this many ticks (longer: it asks for an entry instead) */
export const CELL_REPLAY_CAP = 600;

/** Cell coordinates are offset by this in a key (a system is far smaller than ±4096 cells: ±33,000 km) */
const OFF = 4096;
const SPAN = 8192;

/** A cell's key (one number: cheap to put in a set or on the wire) */
export function focusCellKey(cx: number, cy: number): number {
  return (cx + OFF) * SPAN + (cy + OFF);
}

/** A key's cell coordinates */
export function focusCellXY(key: number): [number, number] {
  return [Math.floor(key / SPAN) - OFF, (key % SPAN) - OFF];
}

/** The cell a coordinate is in (along one axis) */
export function cellCoord(v: number): number {
  return Math.floor(v / CELL_SIZE);
}

/** The cell a point is in */
export function cellAt(x: number, y: number): number {
  return focusCellKey(cellCoord(x), cellCoord(y));
}

/**
 * A ship's home cell now, given the one it had (undefined: none yet): the same while it is within CELL_HOME_SLACK of
 * that cell, otherwise the cell it is in
 */
export function homeCell(prev: number | undefined, x: number, y: number): number {
  if (prev !== undefined) {
    const [cx, cy] = focusCellXY(prev);
    const x0 = cx * CELL_SIZE - CELL_HOME_SLACK, y0 = cy * CELL_SIZE - CELL_HOME_SLACK, s = CELL_SIZE + 2 * CELL_HOME_SLACK;
    if (x >= x0 && x < x0 + s && y >= y0 && y < y0 + s) return prev;
  }
  return cellAt(x, y);
}

/** How far (squared) a point is from a cell's nearest point (0 inside it) */
export function cellDist2(key: number, x: number, y: number): number {
  const [cx, cy] = focusCellXY(key);
  const x0 = cx * CELL_SIZE, y0 = cy * CELL_SIZE;
  const dx = x < x0 ? x0 - x : x > x0 + CELL_SIZE ? x - x0 - CELL_SIZE : 0;
  const dy = y < y0 ? y0 - y : y > y0 + CELL_SIZE ? y - y0 - CELL_SIZE : 0;
  return dx * dx + dy * dy;
}

/** Every cell whose nearest point is within `range` of (x, y), in key order (`out` is cleared and returned) */
export function cellsNear(x: number, y: number, range: number, out: number[] = []): number[] {
  out.length = 0;
  const r2 = range * range;
  const cx0 = cellCoord(x - range), cx1 = cellCoord(x + range), cy0 = cellCoord(y - range), cy1 = cellCoord(y + range);
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      const k = focusCellKey(cx, cy);
      if (cellDist2(k, x, y) <= r2) out.push(k);
    }
  }
  return out;
}

/** A client's focus cells round its ship (`range`: its focus radius, less than FOCUS_RANGE in a crowd: network/crowd.ts) */
export function focusCells(x: number, y: number, out?: number[], range = FOCUS_RANGE): number[] {
  return cellsNear(x, y, range, out);
}

/** ...and its ring: within RING_RANGE and not in the focus (of radius `range`) */
export function ringCells(x: number, y: number, out: number[] = [], range = FOCUS_RANGE): number[] {
  cellsNear(x, y, RING_RANGE, out);
  const f2 = range * range;
  let n = 0;
  for (const k of out) if (cellDist2(k, x, y) > f2) out[n++] = k;
  out.length = n;
  return out;
}

/**
 * How much of a ghost a ship this far from the client's own is drawn as (0 not at all, 1 fully): drawing only. `focus`:
 * the focus radius in effect (a crowd shrinks it, network/crowd.ts); the fade runs over the last km inside it
 */
export function ghostWeight(dist: number, focus = FOCUS_RANGE): number {
  const to = focus - FOCUS_RANGE + GHOST_FADE_TO, from = focus - FOCUS_RANGE + GHOST_FADE_FROM;
  return dist <= from ? 0 : dist >= to ? 1 : (dist - from) / (to - from);
}

// ---- The dropped-cell cache's check ----

const qv = (v: number, places: number) => Math.round(v * dpow(10, places));
const mix = (h: number, v: number) => Math.imul(h ^ (v | 0), 0x9e3779b1) ^ (Math.imul(h, 0x85ebca6b) >>> 13);

/** One ship's replica at a tick as a 32-bit hash: its body (as rounded each tick) and the controls it flew that tick */
export function cellMemberHash(id: number, b: FlightBody, bits: number, q: number): number {
  let h = mix(0x7f4a7c15, id);
  h = mix(h, qv(b.x, SHIP_PRECISION.pos)); h = mix(h, qv(b.y, SHIP_PRECISION.pos));
  h = mix(h, qv(b.vx, SHIP_PRECISION.vel)); h = mix(h, qv(b.vy, SHIP_PRECISION.vel));
  h = mix(h, qv(b.angle, SHIP_PRECISION.angle)); h = mix(h, qv(b.angVel, SHIP_PRECISION.angVel));
  h = mix(h, b.jump ?? 0); h = mix(h, qv(b.jumpScale ?? 1, 4)); h = mix(h, qv(b.cargo ?? 0, 2)); h = mix(h, (b.dodge ?? 0) * 16 + (b.dodgeDir ?? 0));
  h = mix(h, bits); h = mix(h, q);
  h ^= h >>> 15;
  return Math.imul(h, 0x2c1b3c6d) >>> 0;
}

/** A dropped cell's hash: its ships' member hashes in id order (`members`: [id, hash], any order). Never 0 (0 says "none") */
export function cellHash(members: readonly (readonly [number, number])[]): number {
  const sorted = [...members].sort((a, b) => a[0] - b[0]);
  let h = 0x2545f491;
  for (const [id, m] of sorted) { h = mix(h, id); h = mix(h, m); }
  h ^= h >>> 16;
  return (h >>> 0) || 1;
}

/**
 * The wire forms (the `cells` message after a snapshot, CAPS.FOCUS):
 * - `d` drops: [cell, n, id × n] per cell: these ships left its focus with the snapshot just sent; keep them as of its tick
 * - `b` back:  [cell, T] per cell: a cell it dropped at T is in its focus again; answer with cellCache [cell, T, hash or 0]
 * - `l` logs:  [cell, T, n, (id, k, (tick - T, bits, q) × k) × n] per cell: put these back, with the control changes since
 *   T (through the snapshot's tick), and forget the rest of that cell; n = 0: forget it all (they come as new)
 */
export interface CellLogShip { id: number; events: [number, number, number][] }

export function packCellLog(out: number[], cell: number, T: number, ships: readonly CellLogShip[]): void {
  out.push(cell, T, ships.length);
  for (const s of ships) {
    out.push(s.id, s.events.length);
    for (const [t, bits, q] of s.events) out.push(t - T, bits, q);
  }
}

export function unpackCellLogs(l: readonly number[]): { cell: number; T: number; ships: CellLogShip[] }[] {
  const out: { cell: number; T: number; ships: CellLogShip[] }[] = [];
  let i = 0;
  while (i + 2 < l.length) {
    const cell = l[i++], T = l[i++], n = l[i++], ships: CellLogShip[] = [];
    for (let s = 0; s < n && i + 1 < l.length; s++) {
      const id = l[i++], k = l[i++], events: [number, number, number][] = [];
      for (let e = 0; e < k && i + 2 < l.length; e++) { events.push([T + l[i], l[i + 1], l[i + 2]]); i += 3; }
      ships.push({ id, events });
    }
    out.push({ cell, T, ships });
  }
  return out;
}

/** A cell log's size on the wire, roughly (bytes): what's weighed against an entry */
export function cellLogBytes(ships: readonly CellLogShip[]): number {
  let n = 4;
  for (const s of ships) n += 4 + 5 * s.events.length;
  return n;
}

/** An entry's size, roughly, per ship (a keyframe and a status row with where it is: bytes) */
export const CELL_ENTRY_BYTES = 40;
