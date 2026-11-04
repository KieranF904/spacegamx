/**
 * The pieces custom enemies' modules make their flight of (bodies/custom/<id>.ts): holding still, drifting without a
 * drive, turning slowly towards a lost side, crabbing, going for a point. detTrig maths only.
 */

import { datan2, dcos, dhypot, dsin } from '../../math/detTrig.js';
import { dequantizeCursorAngle } from '../../network/cursorState.js';
import roster from './roster.json' with { type: 'json' };
import type { CustomCtx, CustomFlight } from './types.js';

/** Most it turns a tick towards a side it has lost a vane, a wing or a root on (radians) */
export const LAME_TURN = 0.012;

/** A group's bit in a design's byte (bodies/custom/roster.json order) */
export function groupBit(design: string, group: string): number {
  const d = roster.designs.find((r) => r.id === design);
  const i = d ? d.groups.indexOf(group) : -1;
  if (i < 0) throw new Error(`custom enemy ${design}: no group ${group}`);
  return 1 << i;
}

/** Is this piece gone */
export const lost = (c: CustomCtx, bit: number) => (c.gone & bit) !== 0;

/** An angle the 13-bit aim quantisation carries, as radians */
export const angleOf = (q: number) => dequantizeCursorAngle(q);

/** Brake against its own drift (it holds still) */
export function hold(c: CustomCtx, f: CustomFlight): void {
  const v = dhypot(c.me.vx, c.me.vy);
  f.mx = v > 0.6 ? -c.me.vx / v : 0;
  f.my = v > 0.6 ? -c.me.vy / v : 0;
  f.boost = false;
}

/** No drive: it can only turn */
export function drift(f: CustomFlight): void {
  f.mx = 0; f.my = 0; f.boost = false;
}

/** Facing its target */
export function faceTarget(c: CustomCtx, f: CustomFlight): void {
  f.face = datan2(c.tgt.y - c.me.y, c.tgt.x - c.me.x);
}

/** Going for a point (boosting when it's far) */
export function goTo(c: CustomCtx, f: CustomFlight, x: number, y: number, boostPast = 1200): void {
  const dx = x - c.me.x, dy = y - c.me.y, d = dhypot(dx, dy) || 1;
  f.mx = dx / d; f.my = dy / d; f.boost = d > boostPast;
  f.face = datan2(dy, dx);
}

/**
 * A lost side (-1 its left, 1 its right, as it faces): turning that way it manages only LAME_TURN a tick from where it
 * points now, so it comes round slowly and its aim lags; the other way it turns as ever
 */
export function lame(c: CustomCtx, f: CustomFlight, side: -1 | 1): void {
  const d = datan2(dsin(f.face - c.me.angle), dcos(f.face - c.me.angle));
  // (y runs down the screen: a turn to its right is a positive one)
  if (d * side > LAME_TURN) f.face = c.me.angle + side * LAME_TURN;
}

/** One drive lost of two: it crabs, its motion turned `side` (radians) off what it wanted */
export function crab(f: CustomFlight, turn: number): void {
  if (!f.mx && !f.my) return;
  const c = dcos(turn), s = dsin(turn), mx = f.mx * c - f.my * s, my = f.mx * s + f.my * c;
  f.mx = mx; f.my = my;
}
