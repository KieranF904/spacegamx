/**
 * Docking Clamps' rules (docs/design/groups-mines-docking.md, "Docking clamps"). Two ships each with a clamp of the same
 * size, mouths facing each other and lined up within CLAMP's tolerances, may lock together when both pilots press the
 * dock key: they then fly as one rigid body, one pilot steering. Every number here is a starting point to playtest.
 *
 * Pure and deterministic (exact arithmetic and the deterministic trig): the server decides a lock, a swap and an
 * undock (decision records), and every end works the joined pair out from them alike. The lined-up test runs on each
 * client for the prompt too, so the prompt needs no message.
 */

import { datan2, dhypot, dsincos } from '../../../math/detTrig.js';
import type { FunctionDef } from '../../types.js';

export const CLAMP = Object.freeze({
  /** Lined up: the mouths at most this far apart (world units; a cell is 24) */
  reach: 30,
  /** ...this far off each other's line, sideways */
  lateral: 10,
  /** ...facing each other within this many radians (~10 degrees) */
  angle: 0.175,
  /** ...and moving apart or together, or sliding, slower than this (world units a tick), turning against each other slower than this (radians a tick) */
  speed: 2,
  spin: 0.03,
  /** The prompt shows within these multiples of the tolerances (so it doesn't flicker on the edge), the lock needs them */
  promptSlack: 1.5,
  /** Both pilots must press within this many ticks of each other (3 s): a press waits that long for the other's */
  pressWindow: 180,
  /** Undocking pushes the two apart along the clamps' line at this speed each (world units a tick), so they don't relock at once */
  undockPush: 1.5,
  /** After an undock or a break the same pair can't lock again for this many ticks */
  relockTicks: 120,
});

/** A model's clamp, cleaned (absent: not a clamp) */
export function clampOf(fn: FunctionDef): { size: number } | null {
  const c = fn.clamp;
  return c ? { size: Math.max(1, Math.min(4, Math.floor(c.size || 1))) } : null;
}

/** What a rebuild derives for a ship with a working Docking Clamp (`derived.fx.clamp`) */
export interface ClampInfo {
  /** Each working clamp, in part order: its part index and uid, its size, its mouth (grid units) and outward way (grid frame) */
  clamps: { part: number; uid: number; size: number; mouth: [number, number]; dir: [number, number] }[];
}

declare module '../types.js' {
  interface FeatureDerived { clamp?: ClampInfo }
}

/** A pose and its motion (world units, radians; a FlightBody is one) */
export interface ClampBody { x: number; y: number; vx: number; vy: number; angle: number; angVel: number }

/** A clamp's mouth in the world: its point and outward unit vector */
export interface ClampWorld { x: number; y: number; nx: number; ny: number }

/** The world angle of a grid-frame direction on a ship at `angle` (grid forward is -y: flight.ts localToWorldDir) */
const SC: [number, number] = [0, 0];
function rotate(vx: number, vy: number, angle: number, out: [number, number]): [number, number] {
  dsincos(angle + Math.PI / 2, SC);
  const s = SC[0], c = SC[1];
  out[0] = vx * c - vy * s; out[1] = vx * s + vy * c;
  return out;
}
const V: [number, number] = [0, 0];

/** A clamp's mouth in the world, for a ship whose centre of mass is `com` (grid units) at `body` */
export function clampWorld(c: ClampInfo['clamps'][number], com: readonly [number, number], cellSize: number, body: ClampBody, out: ClampWorld = { x: 0, y: 0, nx: 0, ny: 0 }): ClampWorld {
  rotate((c.mouth[0] - com[0]) * cellSize, (c.mouth[1] - com[1]) * cellSize, body.angle, V);
  out.x = body.x + V[0]; out.y = body.y + V[1];
  rotate(c.dir[0], c.dir[1], body.angle, V);
  out.nx = V[0]; out.ny = V[1];
  return out;
}

/** How well two clamp mouths line up: gap along a's normal, sideways offset, how far off facing each other (radians) */
export interface ClampFit { gap: number; lateral: number; angle: number }

export function clampFit(a: Readonly<ClampWorld>, b: Readonly<ClampWorld>, out: ClampFit = { gap: 0, lateral: 0, angle: 0 }): ClampFit {
  const dx = b.x - a.x, dy = b.y - a.y;
  out.gap = dx * a.nx + dy * a.ny;
  out.lateral = Math.abs(dx * -a.ny + dy * a.nx);
  // (Facing each other: b's normal is the reverse of a's)
  out.angle = Math.abs(datan2(a.nx * -b.ny - a.ny * -b.nx, a.nx * -b.nx + a.ny * -b.ny));
  return out;
}

/**
 * Lined up well enough to lock (slack 1) or to show the prompt (CLAMP.promptSlack): mouths close, in line, facing, and
 * the two bodies moving and turning together. Same-size clamps only (the caller checks the sizes)
 */
export function clampLinedUp(fit: Readonly<ClampFit>, a: Readonly<ClampBody>, b: Readonly<ClampBody>, slack = 1): boolean {
  if (fit.gap < -CLAMP.reach * slack * 0.5 || fit.gap > CLAMP.reach * slack) return false;
  if (fit.lateral > CLAMP.lateral * slack || fit.angle > CLAMP.angle * slack) return false;
  if (dhypot(a.vx - b.vx, a.vy - b.vy) > CLAMP.speed * slack) return false;
  return Math.abs(a.angVel - b.angVel) <= CLAMP.spin * slack;
}

/**
 * The follower's place in the leader's frame once locked (snapped exact: mouths together, facing each other): its
 * centre of mass offset from the leader's (world units, in the leader's frame as at angle 0) and its angle less the
 * leader's. Pure geometry from the two ships' clamps and centres of mass; the same on every end
 */
export interface ClampOffset { ox: number; oy: number; oa: number }

export function clampOffset(
  lc: ClampInfo['clamps'][number], lcom: readonly [number, number],
  fc: ClampInfo['clamps'][number], fcom: readonly [number, number], cellSize: number,
): ClampOffset {
  // (In grid frames: the follower turns so its clamp's way is the reverse of the leader's)
  const oa = datan2(-lc.dir[1], -lc.dir[0]) - datan2(fc.dir[1], fc.dir[0]);
  const a = Math.round(wrap(oa) * 1e5) / 1e5;
  dsincos(a, SC);
  const s = SC[0], c = SC[1];
  const fx = (fc.mouth[0] - fcom[0]) * cellSize, fy = (fc.mouth[1] - fcom[1]) * cellSize;
  const lx = (lc.mouth[0] - lcom[0]) * cellSize, ly = (lc.mouth[1] - lcom[1]) * cellSize;
  // (The follower's mouth, turned by `a`, lands on the leader's)
  const ox = lx - (fx * c - fy * s), oy = ly - (fx * s + fy * c);
  return { ox: Math.round(ox * 100) / 100, oy: Math.round(oy * 100) / 100, oa: a };
}

/** The follower's pose from the leader's (rounded as ships are: position 2 decimals, angle 5) */
export function followerPose(leader: Readonly<ClampBody>, o: Readonly<ClampOffset>, out: ClampBody = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 }): ClampBody {
  rotate(o.ox, o.oy, leader.angle, V);
  out.x = Math.round((leader.x + V[0]) * 100) / 100;
  out.y = Math.round((leader.y + V[1]) * 100) / 100;
  out.angle = Math.round(wrap(leader.angle + o.oa) * 1e5) / 1e5;
  // (A point on a turning body: v + w x r)
  out.vx = Math.round((leader.vx - leader.angVel * V[1]) * 1e4) / 1e4;
  out.vy = Math.round((leader.vy + leader.angVel * V[0]) * 1e4) / 1e4;
  out.angVel = leader.angVel;
  return out;
}

const TAU = Math.PI * 2;
function wrap(a: number): number {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}

/** The two ships' pair key (lower id first), for tables of locks and presses */
export const pairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
