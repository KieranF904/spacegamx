/**
 * A staged boss's flight as a shared body (docs/design/decision-inputs.md, build stage 2): between moves it circles its
 * target at its stage's range, held to its ground, driving harder than its engines when its stage is light; a move
 * holds it, turns it, or sends it off a way with a kick (a dart, a charge). The brain (server/src/game/brains/staged.ts)
 * only decides (bodies/decisions.ts): this works the controls and the drive's push out of the decisions and the two
 * ships' states, the same on the server and on a client's tick-aligned layer.
 *
 * Pure of its inputs: the body's state, the boss as it ended the last tick, its target as it is when the boss's step
 * runs (after the target's own step, before that tick's pulls and contacts), and the tick. detTrig maths only.
 */

import { datan2, dcos, dhypot, dsin } from '../math/detTrig.js';
import { quantizeCursorAngle, dequantizeCursorAngle } from '../network/cursorState.js';
import { CTL } from '../ships/replica.js';
import { WANT, type BodyState } from './decisions.js';

/** A staged boss's flight, by stage (index 0 its first) */
export interface StagedFlightTables {
  /** The range it holds off at between moves, and how far round it circles each time */
  range: readonly number[];
  circle: readonly number[];
  /** How much harder than its engines it drives (world units a tick) */
  drive: readonly number[];
  /** Never further than this from home */
  homeR: number;
}

/** A ship's state as the body reads it */
export interface BodyPose { x: number; y: number; angle: number; vx: number; vy: number }

/** What the body flies with this tick: control bits (CTL), the aim (q13), and the push added before the step */
export interface BodyOut { bits: number; q: number; ix: number; iy: number }

/** The 13-bit aim's whole turn */
const AIM_TURN = 8191;
/** The push's grid (world units a tick) */
const IMPULSE_GRID = 1024;
const onGrid = (v: number) => Math.round(v * IMPULSE_GRID) / IMPULSE_GRID;

/** Where a point is held to: within homeR of home */
export function keepHome(T: StagedFlightTables, s: BodyState, x: number, y: number): [number, number] {
  const dx = x - s.homeX, dy = y - s.homeY, d = dhypot(dx, dy), R = T.homeR;
  return d <= R ? [x, y] : [s.homeX + (dx / d) * R, s.homeY + (dy / d) * R];
}

/**
 * This tick's controls and push. `tgt` null: its target isn't known here (it can't be flown: the caller treats the
 * boss as not run by its body)
 */
export function stagedFlight(T: StagedFlightTables, s: BodyState, me: BodyPose, tgt: BodyPose, tick: number): BodyOut {
  const si = Math.max(0, Math.min(T.range.length - 1, s.stage - 1)), w = s.want, kind = w[0];
  const tx = tgt.x, ty = tgt.y, range = T.range[si];
  let mx = 0, my = 0, face: number | undefined;
  const holding = kind === WANT.HOLD || kind === WANT.HOLD_AIM || kind === WANT.HOLD_FACE || kind === WANT.HOLD_LEAD;
  if (holding) {
    const v = dhypot(me.vx, me.vy);
    if (v > 0.8) { mx = -me.vx / v; my = -me.vy / v; }
    if (kind === WANT.HOLD_AIM) face = datan2(ty - me.y, tx - me.x);
    else if (kind === WANT.HOLD_FACE) face = dequantizeCursorAngle(w[1] ?? 0);
    else if (kind === WANT.HOLD_LEAD) { const k = w[1] ?? 0; face = datan2(ty + tgt.vy * k - me.y, tx + tgt.vx * k - me.x); }
  } else if (kind === WANT.DRIVE) {
    const a = dequantizeCursorAngle(w[1] ?? 0);
    mx = dcos(a); my = dsin(a);
    if (w[2]) face = dequantizeCursorAngle(w[2] - 1);
  } else {
    const a = datan2(me.y - ty, me.x - tx) + T.circle[si] * s.side;
    const [px, py] = keepHome(T, s, tx + dcos(a) * range, ty + dsin(a) * range);
    const sx = px - me.x, sy = py - me.y, d = dhypot(sx, sy) || 1;
    if (d > 160) { mx = sx / d; my = sy / d; }
  }
  const fly = kind === WANT.FLY || kind > WANT.HOLD_LEAD;
  const boost = fly && dhypot(tx - me.x, ty - me.y) > range * 1.6 && dhypot(me.x - s.homeX, me.y - s.homeY) < T.homeR * 0.8;
  const bits = (my < -0.38 ? CTL.forward : 0) | (my > 0.38 ? CTL.backward : 0) | (mx < -0.38 ? CTL.left : 0) | (mx > 0.38 ? CTL.right : 0) | (boost ? CTL.boost : 0);
  let q = quantizeCursorAngle(face ?? (mx || my ? datan2(my, mx) : me.angle));
  // (a whole turn is no turn: the aim as the server's step rounds it again)
  if (q === AIM_TURN) q = 0;
  let ix = 0, iy = 0;
  // (A drive's kick, on its first tick)
  if (kind === WANT.DRIVE && tick === s.wantAt && w[3]) { ix = mx * (w[3] / 16); iy = my * (w[3] / 16); }
  // (Lighter stages drive harder than their engines: along the way it goes, unless it's holding)
  const drive = T.drive[si] ?? 0;
  if (drive && !holding && (mx || my)) {
    const l = dhypot(mx, my);
    ix += (mx / l) * drive; iy += (my / l) * drive;
  }
  return { bits, q, ix: onGrid(ix), iy: onGrid(iy) };
}
