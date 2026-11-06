/**
 * The enemy AI's pilot as a shared body (docs/design/decision-inputs.md 6.5, build stage 7): the server's commander
 * (server/src/game/Enemies.ts `fly`, its think) decides the ship's order, its target and which way it strafes; this
 * flies it from them tick by tick, the same on the server and on a client's tick-aligned layer (CAPS.PILOTS). Nothing
 * here reads the server's RNG, its damage ledger or a ship the client doesn't hold: what those decide goes in the order.
 *
 * An order is a body want ([state, ...args]: bodies/decisions.ts WANT carries it), whole numbers only:
 *
 *   PATROL  [0, wx, wy, pace, pauseUntil]  to a waypoint, cruising in pulses: thrusting while (tick + id × 13) % 120 is
 *                                          at most `pace`, holding still before tick `pauseUntil`
 *   RETURN  [1, hx, hy]                    home, straight
 *   ENGAGE  [2, range, reach, hitBy, errMax, seed, strafe, flank, ...mates]
 *                                          at its target: its fighting range and its guns' reach; hitBy bit 0 while its
 *                                          target has shot it lately (shot at from past its reach it closes in), bit 1
 *                                          when one of its guns lobs (it fires from further off: aiFires);
 *                                          its aim off by up to errMax (1/AIM_ERR_GRID radians) either way, re-rolled
 *                                          every 12 + id % 7 ticks from its seed (aiAimError: the commander rolled the
 *                                          seed, so nobody works its misses out ahead); strafing while (tick + id × 7) % 180 is
 *                                          under `strafe`; a pack's ships (flank q13 + 1, mates as ids less its own)
 *                                          fight from round the side the pack is on (its centroid as the ships ended
 *                                          the last tick, summed in id order); flank 0: alone, from its own side
 *   FLEE    [3]                            away from its target, boosting
 *   HAUL    [5, arrive, reach, flags, errMax, seed, wx, wy]
 *                                          a freighter on its course (flags bit 0: to (wx, wy), flown as the autopilot
 *                                          flies one, bridge/pilotless.ts autopilotControls; else holding its heading),
 *                                          never turning to fight; its guns on its target (whoever last shot it) as an
 *                                          ENGAGE's are: reach, lobs (flags bit 1), aim error and trigger alike (aiFires)
 *
 * Its heading is held until the wanted one drifts (a hair in a fight, more otherwise), as the aim it steered by last
 * tick has it (`prevQ`: the replica's), so it changes its controls no more often than before.
 */

import { datan2, dcos, dhypot, dsin } from '../math/detTrig.js';
import { quantizeCursorAngle, dequantizeCursorAngle } from '../network/cursorState.js';
import { CTL } from '../ships/replica.js';
import { FRICTION } from '../constants.js';
import { hashUnit } from '../math/rng.js';
import type { BodyState, WantRec } from './decisions.js';
import type { BodyOut, BodyPose } from './stagedFlight.js';
import { CUSTOM_DESIGNS, CO, moveAt, type CustomCtx, type CustomFlight } from './custom/index.js';

/** CUSTOM: a custom enemy's ENGAGE, its design, pieces gone and move in it (bodies/custom/order.ts) */
export const AI_ORDER = { PATROL: 0, RETURN: 1, ENGAGE: 2, FLEE: 3, CUSTOM: 4, HAUL: 5 } as const;
/** An order that fights its target (ENGAGE, or a custom enemy's) */
const engages = (w: WantRec) => w[0] === AI_ORDER.ENGAGE || w[0] === AI_ORDER.CUSTOM;
/** An order whose guns aim at its target with an aim error (an engage, or a freighter shooting back) */
const aims = (w: WantRec) => engages(w) || w[0] === AI_ORDER.HAUL;
/** Where an engage order's mates start */
const matesAt = (w: WantRec) => (w[0] === AI_ORDER.CUSTOM ? CO.MATES : 8);
/** The aim error's grid (radians × this) */
export const AIM_ERR_GRID = 4096;
/** Strafing every tick (no `strafe` share in its behaviour) */
export const ALWAYS_STRAFE = 180;

/** The 13-bit aim's whole turn */
const AIM_TURN = 8191;
/** Its thrust's controls */
const THRUST = CTL.forward | CTL.backward | CTL.left | CTL.right;

export const orderPatrol = (wx: number, wy: number, pace: number, pauseUntil: number): WantRec =>
  [AI_ORDER.PATROL, Math.round(wx), Math.round(wy), Math.floor(120 * pace), Math.max(0, Math.ceil(pauseUntil))];
export const orderReturn = (hx: number, hy: number): WantRec => [AI_ORDER.RETURN, Math.round(hx), Math.round(hy)];
export const orderFlee = (): WantRec => [AI_ORDER.FLEE];
/**
 * A freighter on its course (`to`: its autopilot's, null: holding its heading), its guns at its target from up to
 * `reach` (its guns' real reach), its aim off by up to `errMax` radians from `seed`; `lobs` as orderEngage's
 */
export const orderHaul = (to: { x: number; y: number; arrive: number } | null, reach: number, errMax: number, seed: number, lobs = false): WantRec =>
  [AI_ORDER.HAUL, Math.round(to?.arrive ?? 0), Math.round(reach), (to ? 1 : 0) | (lobs ? 2 : 0), Math.round(errMax * AIM_ERR_GRID), seed & 255, Math.round(to?.x ?? 0), Math.round(to?.y ?? 0)];
/**
 * At its target. `strafe`: its behaviour's share of the time it strafes (undefined: always); `flank` (radians) and
 * `mates` (its pack's other ships, ids) only for a pack of more than one
 */
export function orderEngage(id: number, range: number, reach: number, hitBy: boolean, errMax: number, seed: number, strafe: number | undefined, flank?: number, mates?: readonly number[], lobs = false): WantRec {
  const out = [AI_ORDER.ENGAGE, Math.round(range), Math.round(reach), (hitBy ? 1 : 0) | (lobs ? 2 : 0), Math.round(errMax * AIM_ERR_GRID), seed & 255,
    strafe === undefined ? ALWAYS_STRAFE : Math.max(0, Math.min(ALWAYS_STRAFE, Math.ceil(180 * strafe))), 0];
  if (flank !== undefined && mates?.length) {
    out[7] = quantizeCursorAngle(flank) + 1;
    for (const m of [...mates].sort((a, b) => a - b)) out.push(m - id);
  }
  return out;
}

/** An engage order's pack (its own id with its mates', in id order), or null: it fights alone */
export function orderPack(id: number, w: WantRec): number[] | null {
  const m0 = matesAt(w);
  if (!engages(w) || !w[7] || w.length <= m0) return null;
  const ids = [id];
  for (let i = m0; i < w.length; i++) ids.push(id + w[i]);
  return ids.sort((a, b) => a - b);
}

/** A pack's centroid from its ships as they ended the last tick, summed in id order (null: one isn't known) */
export function packCentroid(ids: readonly number[], at: (id: number) => { x: number; y: number } | null): [number, number] | null {
  let cx = 0, cy = 0;
  for (const m of ids) {
    const p = at(m);
    if (!p) return null;
    cx += p.x; cy += p.y;
  }
  return [cx / ids.length, cy / ids.length];
}

/** An engage order's aim error at tick t (radians): re-rolled every 12 + id % 7 ticks from the order's seed */
export function aiAimError(w: WantRec, id: number, t: number): number {
  if (!aims(w) || !w[4]) return 0;
  return (w[4] / AIM_ERR_GRID) * (hashUnit(w[5], id, Math.floor(t / (12 + (id % 7)))) * 2 - 1);
}

/** Ships its body reads besides itself (its target, its pack's): a client must hold them all to run it */
export function aiReads(id: number, s: BodyState): number[] {
  const w = s.want;
  if (!aims(w) && w[0] !== AI_ORDER.FLEE) return [];
  const out = s.target >= 0 ? [s.target] : [];
  for (const m of orderPack(id, w) ?? []) if (m !== id) out.push(m);
  return out;
}

/** What the pilot flies with this tick, and whether and where its guns fire */
export interface AiPilotOut extends BodyOut {
  /** The guns' aim (world angle) and how far, when it has a target */
  aim?: number;
  aimDist: number;
  /**
   * Its trigger (aiFires): an ENGAGE order at its target, within its guns' real reach, when a hit is likely. Part of
   * its controls on both ends (bodies flown on a client's tick layer fire there too: sim/otherGuns.ts)
   */
  fire: boolean;
  /** Its distance to the target, how fast the target crosses its line, and a shell's time of flight */
  d: number;
  across: number;
  tof: number;
}

/**
 * This tick's controls. `tgt`: its target as the step reads it (null: none, or not known); `centroid`: its pack's (an
 * ENGAGE order with mates); `prevQ`: the aim it steered by last tick; `prevBits`: the controls it flew with then (a
 * custom enemy's module holds a thrust it's making rather than flick it on and off: bodies/custom/flight.ts keepAt)
 */
export function aiPilot(s: BodyState, me: BodyPose, tgt: (BodyPose & { r?: number }) | null, centroid: readonly [number, number] | null, tick: number, id: number, prevQ: number, prevBits = 0): AiPilotOut {
  const w = s.want, state = w[0];
  if (state === AI_ORDER.HAUL) return haul(w, me, tgt, tick, id, prevQ);
  let mx = 0, my = 0, face = me.angle, boost = false, aim: number | undefined, aimDist = 0, d = 0, across = 0, tof = 0, fire = false;
  // (A custom enemy: its module, the move under way and its pieces gone: bodies/custom)
  const custom = state === AI_ORDER.CUSTOM && tgt ? customCtx(w, id, tick, me, tgt, prevBits) : null;
  if ((state === AI_ORDER.ENGAGE || state === AI_ORDER.CUSTOM) && tgt) {
    const tx = tgt.x, ty = tgt.y, dx = tx - me.x, dy = ty - me.y;
    d = dhypot(dx, dy) || 1;
    const [range, reach] = custom?.design.ranges ? custom.design.ranges(custom.c, w[1], w[2]) : [w[1], w[2]];
    // Lead the target by the shell's flight time
    tof = Math.min(40, d / 45);
    const rvx = tgt.vx - me.vx, rvy = tgt.vy - me.vy;
    const lx = dx + rvx * tof, ly = dy + rvy * tof;
    face = datan2(ly, lx) + aiAimError(w, id, tick);
    aim = face;
    aimDist = dhypot(lx, ly);
    // Shot at from beyond its own guns' reach, it closes in fast instead of sitting there taking it
    const outgunned = (w[3] & 1) === 1 && d > reach * 0.85;
    const want = outgunned ? Math.min(range, reach * 0.6) : range;
    // Where to fight from: its range, round the target at its place in the pack's spread
    const side = w[7] && centroid ? datan2(centroid[1] - ty, centroid[0] - tx) + dequantizeCursorAngle(w[7] - 1) : datan2(me.y - ty, me.x - tx);
    const sx = tx + dcos(side) * want - me.x, sy = ty + dsin(side) * want - me.y;
    const off = dhypot(sx, sy);
    const ux = dx / d, uy = dy / d;
    if (outgunned) { mx = ux; my = uy; boost = true; }
    else if (off > Math.max(250, want * 0.35)) { mx = sx / off; my = sy / off; boost = off > want * 2.5; }
    else if (d < want * 0.7) { mx = -ux; my = -uy; }
    else if ((tick + id * 7) % 180 < w[6]) { mx = -uy * s.side; my = ux * s.side; }
    else {
      // Hold: brake against its own drift
      const v = dhypot(me.vx, me.vy);
      if (v > 0.6) { mx = -me.vx / v; my = -me.vy / v; }
    }
    across = Math.abs(rvx * uy - rvy * ux);
    // (A custom enemy fires no part guns: its moves are its attacks, bodies/moves)
    if (state === AI_ORDER.ENGAGE) fire = aiFires(w, id, tick, d, across, tof, tgt.r);
    if (custom?.design.fly) {
      const f: CustomFlight = { mx, my, face, boost };
      custom.design.fly(custom.c, f);
      mx = f.mx; my = f.my; face = f.face; boost = f.boost;
    }
  } else if (state === AI_ORDER.FLEE && tgt) {
    const dx = me.x - tgt.x, dy = me.y - tgt.y, dd = dhypot(dx, dy) || 1;
    mx = dx / dd; my = dy / dd; boost = true;
    face = datan2(my, mx);
  } else if (state === AI_ORDER.PATROL || state === AI_ORDER.RETURN) {
    const dx = w[1] - me.x, dy = w[2] - me.y, dd = dhypot(dx, dy) || 1;
    if (dd > 200) { mx = dx / dd; my = dy / dd; face = datan2(dy, dx); }
    // Cruise gently on patrol: thrust in pulses (each pack at its own pace), or hold still a while
    if (state === AI_ORDER.PATROL && ((tick + id * 13) % 120 > w[3] || tick < w[4])) { mx = 0; my = 0; }
  }
  // Steer by a heading held steady until the wanted one drifts (the guns aim separately, every tick)
  const held = dequantizeCursorAngle(prevQ);
  let q = Math.abs(datan2(dsin(face - held), dcos(face - held))) > (engages(w) ? 0.004 : 0.02) ? quantizeCursorAngle(face) : prevQ;
  // (a whole turn is no turn: the aim as the server's step rounds it again)
  if (q === AIM_TURN) q = 0;
  // Mouse-steer controls are screen-relative: press the directions nearest the wanted motion
  const bits = (my < -0.38 ? CTL.forward : 0) | (my > 0.38 ? CTL.backward : 0) | (mx < -0.38 ? CTL.left : 0) | (mx > 0.38 ? CTL.right : 0) | (boost ? CTL.boost : 0);
  return { bits, q, ix: 0, iy: 0, aim, aimDist, d, across, tof, fire };
}

/**
 * A HAUL order's tick: its course as the autopilot flies one (bridge/pilotless.ts autopilotControls: the heading held
 * until the course drifts 0.02 rad, the screen directions nearest the nose pressed while roughly facing it and not yet
 * due to coast to a stop at the arrival radius), its guns led onto its target as an ENGAGE's are, never steering for it
 */
function haul(w: WantRec, me: BodyPose, tgt: (BodyPose & { r?: number }) | null, tick: number, id: number, prevQ: number): AiPilotOut {
  let q = prevQ, bits = 0, aim: number | undefined, aimDist = 0, d = 0, across = 0, tof = 0, fire = false;
  if (w[3] & 1) {
    const arrive = w[1], dx = w[6] - me.x, dy = w[7] - me.y, dist = dhypot(dx, dy), want = datan2(dy, dx), held = dequantizeCursorAngle(prevQ);
    if (Math.abs(datan2(dsin(want - held), dcos(want - held))) >= 0.02 || dist <= arrive) q = quantizeCursorAngle(want);
    const course = dequantizeCursorAngle(q), err = datan2(dsin(course - me.angle), dcos(course - me.angle));
    // (Friction alone stops a ship moving at v within about v / (1 - FRICTION))
    if (Math.abs(err) < 0.5 && dist - arrive > dhypot(me.vx, me.vy) / (1 - FRICTION)) {
      const cx = dcos(me.angle), cy = dsin(me.angle);
      bits = (cy < -0.38 ? CTL.forward : 0) | (cy > 0.38 ? CTL.backward : 0) | (cx < -0.38 ? CTL.left : 0) | (cx > 0.38 ? CTL.right : 0);
    }
  }
  // (a whole turn is no turn: the aim as the server's step rounds it again; its autopilot's course can be on it)
  if (q === AIM_TURN) q = 0;
  if (tgt) {
    const dx = tgt.x - me.x, dy = tgt.y - me.y;
    d = dhypot(dx, dy) || 1;
    tof = Math.min(40, d / 45);
    const rvx = tgt.vx - me.vx, rvy = tgt.vy - me.vy, lx = dx + rvx * tof, ly = dy + rvy * tof;
    aim = datan2(ly, lx) + aiAimError(w, id, tick);
    aimDist = dhypot(lx, ly);
    across = Math.abs((rvx * dy - rvy * dx) / d);
    fire = aiFires(w, id, tick, d, across, tof, tgt.r);
  }
  return { bits, q, ix: 0, iy: 0, aim, aimDist, d, across, tof, fire };
}

/**
 * An ENGAGE order's trigger: within its guns' real reach (the order's), when a hit is likely: a big, slow, near target,
 * or a lobbed shell. `size`: its target's radius as this end has its structure (60 not known). Was the commander's
 * (server Enemies.ts); a body flown on a client's tick layer works it out the same
 */
export function aiFires(w: WantRec, id: number, tick: number, d: number, across: number, tof: number, size = 60): boolean {
  const spread = d * (Math.abs(aiAimError(w, id, tick)) + 0.015) + across * tof * 0.6;
  return d <= w[2] * 0.95 && (d < 900 || (w[3] & 2) !== 0 || size / Math.max(1, spread) > 0.25);
}

/** A custom enemy's module and what it reads this tick (null: its design isn't known: it flies as the plain AI) */
function customCtx(w: WantRec, id: number, t: number, me: BodyPose, tgt: BodyPose, bits: number): { design: (typeof CUSTOM_DESIGNS)[number]; c: CustomCtx } | null {
  const design = CUSTOM_DESIGNS[w[CO.DESIGN]];
  if (!design) return null;
  const m = moveAt(w, t, (i) => design.moves[i]?.ticks ?? 0);
  return { design, c: { w, id, t, me, tgt, gone: w[CO.GONE], move: m ? m.move : -1, k: m ? m.k : -1, arg: w[CO.ARG], seed: w[CO.MSEED], bits: bits & THRUST } };
}
