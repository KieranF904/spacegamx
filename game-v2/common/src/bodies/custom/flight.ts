/**
 * The pieces custom enemies' modules make their flight of (bodies/custom/<id>.ts): holding still, drifting without a
 * drive, turning slowly towards a lost side, crabbing, going for a point. detTrig maths only.
 */

import { datan2, dcos, dhypot, dsin } from '../../math/detTrig.js';
import { dequantizeCursorAngle } from '../../network/cursorState.js';
import roster from './roster.json' with { type: 'json' };
import type { CustomCtx, CustomFlight } from './types.js';

/**
 * keepAt starts a thrust when it lacks this much of the velocity it wants (world units a tick), and holds one it's
 * making until it lacks less than KEEP_DONE or the thrust is KEEP_OFF off the way it needs: whole bursts, not its engines
 * flicking on and off (and between neighbouring ways) every tick
 */
const KEEP_START = 3, KEEP_DONE = 0.3, KEEP_OFF = 1.2;
/** The thrust's controls (CTL forward, backward, left, right) */
const FWD = 1, BACK = 2, LEFT = 4, RIGHT = 8;

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
 * The heading from a point to where its target will be when a shell `speed` fast from there reaches it, `extra` ticks
 * on (a line drawn now and fired down later: its warning's ticks), the target held to its course. Its lead goes at most
 * `most` world units ahead of it
 */
export function leadFrom(x: number, y: number, tgt: { x: number; y: number; vx: number; vy: number }, speed: number, extra = 0, most = 1400): number {
  const t = dhypot(tgt.x - x, tgt.y - y) / Math.max(1, speed) + extra;
  let lx = tgt.vx * t, ly = tgt.vy * t;
  const l = dhypot(lx, ly);
  if (l > most) { lx *= most / l; ly *= most / l; }
  return datan2(tgt.y + ly - y, tgt.x + lx - x);
}

/** How far a heading is off another (radians, 0 to pi) */
export function offBy(a: number, b: number): number {
  return Math.abs(datan2(dsin(a - b), dcos(a - b)));
}

/**
 * Keep station at a point moving with (vx, vy): it wants that point's velocity plus a closing speed (gain × the gap,
 * at most `close` world units a tick), and thrusts towards what it lacks of that in bursts (KEEP_START, KEEP_DONE: the
 * thrust it flew last tick, `c.bits`, held while it still helps), coasting in between. No overshoot into what it's
 * following, no thrust flipping about the point tick to tick
 */
export function keepAt(c: CustomCtx, f: CustomFlight, x: number, y: number, vx: number, vy: number, gain = 0.05, close = 9): void {
  let wx = (x - c.me.x) * gain, wy = (y - c.me.y) * gain;
  const w = dhypot(wx, wy);
  if (w > close) { wx *= close / w; wy *= close / w; }
  const dx = vx + wx - c.me.vx, dy = vy + wy - c.me.vy, dv = dhypot(dx, dy);
  f.boost = false;
  // (the thrust it's making, as a way: the same controls again if it goes on)
  const px = (c.bits & RIGHT ? 1 : 0) - (c.bits & LEFT ? 1 : 0), py = (c.bits & BACK ? 1 : 0) - (c.bits & FWD ? 1 : 0), pl = dhypot(px, py);
  if (pl && dv > KEEP_DONE && offBy(datan2(py, px), datan2(dy, dx)) < KEEP_OFF) { f.mx = px / pl; f.my = py / pl; return; }
  f.mx = dv > KEEP_START ? dx / dv : 0; f.my = dv > KEEP_START ? dy / dv : 0;
}

/** Its nose turned at most `rate` radians a tick towards the heading it wants (a slow, gentle turner) */
export function turnAtMost(c: CustomCtx, f: CustomFlight, rate: number): void {
  const d = datan2(dsin(f.face - c.me.angle), dcos(f.face - c.me.angle));
  if (d > rate) f.face = c.me.angle + rate;
  else if (d < -rate) f.face = c.me.angle - rate;
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
