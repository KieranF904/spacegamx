/**
 * A volley of mobs laid at once (a Rivet Sower's mines; docs/design/decision-inputs.md 6.3 LAUNCH), as one guide row
 * instead of a SYNC a mob (CAPS.LAUNCHES, with CAPS.WAYPOINTS):
 *
 *   LAUNCH [turn, accel, max, arm, x, y, line, n, ring, gap, ...ids]: `n` mobs born at the row's tick, still, each on
 *          the guide grid at its spot of the pattern round (x, y) (× 256): along the line (q13) `gap` apart, centred,
 *          or (ring 1) round the point at radius `gap`. Their guide kind as a SYNC carries it (arm: ticks less the
 *          row's), no target. ids: the run of mob ids the volley took, in spot order (packIds: the first, then gaps)
 *
 * The server lays them with launchSpots and sends this; a client running mobs makes each one's run from it, as the
 * SYNC would have said. The ids are the server's own (allocation unchanged).
 */
import { dcos, dsin } from '../math/detTrig.js';
import { dequantizeCursorAngle } from '../network/cursorState.js';
import { FLIGHT_MOB, GUIDE_KQ, GUIDE_Q, guideKind, newGuide, qGuide, type Guide, type GuideBody, type GuideKind } from './waypoints.js';

/** Ids as the first, then each one's gap from the one before (ships/debris.ts packIds) */
const packIds = (ids: readonly number[]) => ids.map((id, i) => (i ? id - ids[i - 1] : id));
const unpackIds = (p: readonly number[]) => { const out: number[] = []; for (let i = 0; i < p.length; i++) out.push(i ? out[i - 1] + p[i] : p[i]); return out; };

/** Where a volley's mobs go: round a point (on the guide grid), along a line (q13) `gap` apart, or in a ring of radius `gap` */
export interface LaunchPattern { x: number; y: number; line: number; n: number; ring: boolean; gap: number }

/** Mobs a volley lays at most (a guide row is 24 numbers at most: guideRowOk) */
export const LAUNCH_MAX = 10;

/** The pattern with its point put on the guide grid (as the row carries it) */
export function launchPattern(x: number, y: number, line: number, n: number, ring: boolean, gap: number): LaunchPattern {
  return { x: qGuide(x), y: qGuide(y), line, n: Math.max(0, Math.min(LAUNCH_MAX, n | 0)), ring, gap: Math.max(0, Math.round(gap)) };
}

/** Each mob's spot, in order, on the guide grid */
export function launchSpots(p: LaunchPattern): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const a = dequantizeCursorAngle(p.line), c = dcos(a), s = dsin(a);
  for (let i = 0; i < p.n; i++) {
    if (p.ring) { const t = (i / p.n) * Math.PI * 2; out.push({ x: qGuide(p.x + dcos(t) * p.gap), y: qGuide(p.y + dsin(t) * p.gap) }); }
    else { const o = (i - (p.n - 1) / 2) * p.gap; out.push({ x: qGuide(p.x + c * o), y: qGuide(p.y + s * o) }); }
  }
  return out;
}

/** A LAUNCH row's args: the volley laid at `tick` (its mobs' guide kind, the pattern, their ids in spot order) */
export function launchArgs(kind: GuideKind, tick: number, p: LaunchPattern, ids: readonly number[]): number[] {
  return [Math.round(kind.turn * GUIDE_KQ), Math.round(kind.accel * GUIDE_KQ), Math.round(kind.max * GUIDE_Q), kind.arm - tick,
    Math.round(p.x * GUIDE_Q), Math.round(p.y * GUIDE_Q), p.line, p.n, p.ring ? 1 : 0, p.gap, ...packIds(ids)];
}

/** What a LAUNCH row says, for its tick: each mob's id, state and guide as the tick ended (null: not a volley it can take) */
export function launchOfArgs(a: readonly number[], tick: number): { id: number; m: GuideBody; g: Guide }[] | null {
  if (a.length < 10) return null;
  const p: LaunchPattern = { x: a[4] / GUIDE_Q, y: a[5] / GUIDE_Q, line: a[6], n: a[7], ring: a[8] === 1, gap: a[9] };
  const ids = unpackIds(a.slice(10));
  if (p.n < 1 || p.n > LAUNCH_MAX || ids.length !== p.n) return null;
  const spots = launchSpots(p);
  return ids.map((id, i) => ({
    id, m: { x: spots[i].x, y: spots[i].y, vx: 0, vy: 0, a: 0 },
    g: newGuide(-1, guideKind(a[0] / GUIDE_KQ, a[1] / GUIDE_KQ, a[2] / GUIDE_Q, FLIGHT_MOB, a[3] + tick)),
  }));
}
