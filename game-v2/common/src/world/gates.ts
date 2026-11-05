/**
 * Boss arenas' barriers (docs/bosses/rework-2026-11.md 7.1): systems.json `arena` encloses a lair boss's chamber. The
 * barrier is built into the system's terrain as gate pieces (TerrainFile `gates`), so collideTerrain, rayTerrain and
 * insideTerrain stop ships, shots, beams, splash and drones at it, both ways, on the server and on every client alike,
 * with no new check anywhere: no sniping in or out, and the boss can't be pulled out.
 *
 * `barrier` is the segment that closes the chamber's one tunnel (its rock does the rest). Without one (a lair with no
 * rock yet) the barrier is the whole ring at `radius`.
 *
 * A pilot passes by pressing interact within GATE.reach of it (server/src/game/arenas/ArenaGates.ts): entering is free,
 * leaving needs GATE.quiet ticks out of combat. Pure: detTrig maths only (the pieces are the same bits everywhere).
 */

import type { Vec2 } from '../ships/types.js';
import type { TerrainFile } from '../terrain.js';
import { dcos, dhypot, dsin } from '../math/detTrig.js';

export interface ArenaDef {
  /** The lair boss it holds (bosses.json id) */
  boss: string;
  centre: { x: number; y: number };
  /** The chamber's reach from its centre: inside is within it */
  radius: number;
  /** The segment closing its tunnel; absent: the whole ring at `radius` is the barrier */
  barrier?: [Vec2, Vec2];
  /** Where a pilot who died or logged out inside comes back (outside the barrier) */
  outside: { x: number; y: number };
}

export const GATE = {
  /** Interact within this of the barrier to pass */
  reach: 400,
  /** Leaving: out of combat this long (no damage dealt or taken) */
  quiet: 300,
  /** The barrier's thickness */
  thick: 80,
  /** A ring barrier's pieces are at most this long */
  piece: 600,
  /** Clearance past the barrier a passing ship is put at, beyond its own collision radius */
  clear: 60,
} as const;

/** The barrier's solid pieces (each convex) */
export function gatePieces(a: ArenaDef): Vec2[][] {
  if (a.barrier) {
    const [[x0, y0], [x1, y1]] = a.barrier;
    const dx = x1 - x0, dy = y1 - y0, l = dhypot(dx, dy) || 1, nx = (-dy / l) * (GATE.thick / 2), ny = (dx / l) * (GATE.thick / 2);
    return [[[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]]];
  }
  const r0 = a.radius, r1 = a.radius + GATE.thick, n = Math.max(12, Math.ceil((2 * Math.PI * r1) / GATE.piece));
  const at = (r: number, k: number): Vec2 => {
    const ang = ((k % n) / n) * 2 * Math.PI;
    return [Math.round((a.centre.x + dcos(ang) * r) * 100) / 100, Math.round((a.centre.y + dsin(ang) * r) * 100) / 100];
  };
  const out: Vec2[][] = [];
  for (let k = 0; k < n; k++) out.push([at(r0, k), at(r1, k), at(r1, k + 1), at(r0, k + 1)]);
  return out;
}

/** A system's terrain with its arena's barrier in it (undefined: no rock and no arena) */
export function withArenaGates(file: TerrainFile | undefined, arena: ArenaDef | undefined): TerrainFile | undefined {
  if (!arena) return file;
  return { ...(file ?? { rocks: [] }), gates: gatePieces(arena) };
}

/**
 * Is a point inside the arena: within its radius of the centre, and (with a barrier) on the centre's side of the
 * barrier's line, so the stretch of tunnel beyond the barrier that the circle takes in counts as outside
 */
export function insideArena(a: ArenaDef, x: number, y: number): boolean {
  if (dhypot(x - a.centre.x, y - a.centre.y) >= a.radius) return false;
  if (!a.barrier) return true;
  const [[x0, y0], [x1, y1]] = a.barrier, nx = -(y1 - y0), ny = x1 - x0;
  const side = (px: number, py: number) => (px - x0) * nx + (py - y0) * ny;
  return side(x, y) * side(a.centre.x, a.centre.y) > 0;
}

/** The nearest point of the barrier to (x, y), and how far it is */
export function nearestGatePoint(a: ArenaDef, x: number, y: number): { x: number; y: number; d: number } {
  if (a.barrier) {
    const [[x0, y0], [x1, y1]] = a.barrier;
    const ex = x1 - x0, ey = y1 - y0, l2 = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * ex + (y - y0) * ey) / l2));
    const px = x0 + ex * t, py = y0 + ey * t;
    return { x: px, y: py, d: dhypot(x - px, y - py) };
  }
  const dx = x - a.centre.x, dy = y - a.centre.y, d = dhypot(dx, dy) || 1, r = a.radius + GATE.thick / 2;
  const px = a.centre.x + (dx / d) * r, py = a.centre.y + (dy / d) * r;
  return { x: px, y: py, d: dhypot(x - px, y - py) };
}

/** Close enough to the barrier to pass (interact) */
export function nearGate(a: ArenaDef, x: number, y: number): boolean {
  return nearestGatePoint(a, x, y).d <= GATE.reach + GATE.thick / 2;
}

/**
 * Where a ship `shipR` across (its terrain collision radius) is put to pass: just beyond the barrier on the other side
 * from where it is (`inward`: into the arena), opposite the nearest point of the barrier
 */
export function passPoint(a: ArenaDef, x: number, y: number, shipR: number, inward: boolean): { x: number; y: number } {
  const g = nearestGatePoint(a, x, y), off = GATE.thick / 2 + shipR + GATE.clear;
  let nx: number, ny: number;
  if (a.barrier) {
    const [[x0, y0], [x1, y1]] = a.barrier;
    const l = dhypot(x1 - x0, y1 - y0) || 1;
    nx = -(y1 - y0) / l; ny = (x1 - x0) / l;
    // (the normal pointing into the arena: towards its centre)
    if ((a.centre.x - g.x) * nx + (a.centre.y - g.y) * ny < 0) { nx = -nx; ny = -ny; }
  } else {
    const dx = g.x - a.centre.x, dy = g.y - a.centre.y, d = dhypot(dx, dy) || 1;
    nx = -dx / d; ny = -dy / d;
  }
  const k = inward ? off : -off;
  return { x: g.x + nx * k, y: g.y + ny * k };
}
