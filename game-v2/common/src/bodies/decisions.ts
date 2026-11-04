/**
 * Decision inputs (docs/design/decision-inputs.md): what a boss's brain (server only) chose, as a record both sides
 * fold into the boss's body state at its tick. The body (bodies/stagedFlight.ts) then flies the boss from that state
 * and the replicas it reads, on the server and on the client's tick-aligned layer alike (CAPS.BODIES).
 *
 * On the wire a snapshot's `d` rows: [id, dt, op, ...args], dt the decision's tick less the snapshot's (0 or less: it
 * took effect on a tick the snapshot covers), args small whole numbers. A decision is never retracted.
 *
 *   SYNC    [kind, homeX, homeY, stage, side, target + 1, ...want]: the whole body state as of the snapshot's tick
 *           (sent with a keyframe of the boss: a client starting to run it, or put right after its check was off)
 *   OFF     []: the body stops flying it (no target: the enemy AI flies it); its rows come the old way again
 *   TARGET  [target + 1]: who it flies at (0: nobody)
 *   SIDE    [side]: which way round it circles (1: clockwise as the brain counts it, 0 the other)
 *   STAGE   [stage]: the stage it fights in (its range, circle and drive)
 *   WANT    [...want]: what its move wants of the ship (WANT below)
 *   PERSONAL [slot, attack, seed]: a personal attack drawn (common bosses/personal.ts): on the pilot in that slot of the
 *           boss's pilot list, from its stage's pool, with its own seed. Its body's flight doesn't change (the attack's
 *           shots and strikes are the boss's, told the usual way): clients may play its tell from it
 */

import { quantizeCursorAngle } from '../network/cursorState.js';
import { ownSimCaps } from '../network/ownTick.js';
import { CAPS } from '../network/hits.js';

export const DECISION = { SYNC: 0, OFF: 1, TARGET: 2, SIDE: 3, STAGE: 4, WANT: 5, PERSONAL: 6 } as const;
/** Ops there are (a row whose op is past this is dropped) */
export const DECISION_OPS = 7;

/**
 * A want: [kind, ...args], angles in the 13-bit aim quantisation (q13)
 *
 *   FLY        [0]: circle its target at its stage's range, held to home
 *   HOLD       [1]: brake to a stop, facing the way it drifts (or as it is)
 *   HOLD_AIM   [2]: brake, turning to face its target
 *   HOLD_FACE  [3, face]: brake, turning to this heading
 *   DRIVE      [4, dir, face + 1, kick]: go this way (face: 0 the way it goes); on its first tick a kick of kick/16
 *              world units a tick along it (a dart, a charge)
 *   HOLD_LEAD  [5, ticks]: brake, turning to face where its target will be in this many ticks
 */
export const WANT = { FLY: 0, HOLD: 1, HOLD_AIM: 2, HOLD_FACE: 3, DRIVE: 4, HOLD_LEAD: 5 } as const;
export type WantRec = readonly number[];

export const wantFly = (): WantRec => [WANT.FLY];
export const wantHold = (): WantRec => [WANT.HOLD];
export const wantAim = (): WantRec => [WANT.HOLD_AIM];
export const wantFace = (angle: number): WantRec => [WANT.HOLD_FACE, quantizeCursorAngle(angle)];
export const wantLead = (ticks: number): WantRec => [WANT.HOLD_LEAD, Math.max(0, Math.round(ticks))];
/** Go this way (its angle), facing `face` (undefined: the way it goes), kicked `kick` world units a tick on its first tick */
export const wantDrive = (dir: number, face?: number, kick = 0): WantRec =>
  [WANT.DRIVE, quantizeCursorAngle(dir), face === undefined ? 0 : quantizeCursorAngle(face) + 1, Math.max(0, Math.min(1023, Math.round(kick * 16)))];

/** The same want, bar a DRIVE's kick (a kick is only its first tick's: carrying on the same way is no new want) */
export function sameWant(a: WantRec, b: WantRec): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[0] === WANT.DRIVE && i === 3 && b[3] === 0) continue;
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** A body's state: everything its step reads besides the replicas and the tick */
export interface BodyState {
  /** Its body (bodies/registry.ts BODY_KINDS index) */
  kind: number;
  /** Where it holds ground (whole world units) */
  homeX: number;
  homeY: number;
  stage: number;
  side: 1 | -1;
  /** Who it flies at (-1: nobody, and then it isn't flying: OFF) */
  target: number;
  want: WantRec;
  /** The tick its want took effect (a DRIVE's kick is on that tick) */
  wantAt: number;
  /** The body flies it (false: OFF, the enemy AI does: the old way) */
  on: boolean;
}

export function cloneBodyState(s: BodyState): BodyState {
  return { ...s };
}

/** The state a SYNC says, from the tick it's for */
export function bodyStateOfSync(args: readonly number[], tick: number): BodyState {
  return {
    kind: args[0] ?? 0, homeX: args[1] ?? 0, homeY: args[2] ?? 0, stage: Math.max(1, args[3] ?? 1), side: args[4] ? 1 : -1,
    target: (args[5] ?? 0) - 1, want: args.length > 6 ? args.slice(6) : [WANT.FLY], wantAt: tick, on: true,
  };
}

/** A SYNC's args for a state */
export function syncArgs(s: BodyState): number[] {
  return [s.kind, s.homeX, s.homeY, s.stage, s.side > 0 ? 1 : 0, s.target + 1, ...s.want];
}

/** One decision folded into a state at its tick (SYNC is taken whole: bodyStateOfSync) */
export function applyDecision(s: BodyState, op: number, args: readonly number[], tick: number): void {
  switch (op) {
    case DECISION.SYNC: Object.assign(s, bodyStateOfSync(args, tick)); break;
    case DECISION.OFF: s.on = false; break;
    case DECISION.TARGET: s.target = (args[0] ?? 0) - 1; break;
    case DECISION.SIDE: s.side = args[0] ? 1 : -1; break;
    case DECISION.STAGE: s.stage = Math.max(1, args[0] ?? 1); break;
    case DECISION.WANT: s.want = args.length ? args.slice() : [WANT.FLY]; s.wantAt = tick; break;
  }
}

/** Is this a row the decisions can take ([id, dt, op, ...args], whole numbers, a known op)? */
export function decisionRowOk(row: unknown): row is number[] {
  if (!Array.isArray(row) || row.length < 3 || row.length > 32) return false;
  for (const v of row) if (typeof v !== 'number' || !Number.isInteger(v)) return false;
  return row[0] >= 0 && row[2] >= 0 && row[2] < DECISION_OPS;
}

/** Do these caps have the client run bosses' bodies (CAPS.BODIES, with OWN_SIM: a body reads its own ship there)? */
export function bodiesFor(caps: number | undefined): boolean {
  return ((caps ?? 0) & CAPS.BODIES) !== 0 && ownSimCaps(caps);
}

/**
 * Do these caps have the client run the enemy AI's pilots too (CAPS.PILOTS, with BODIES and CAUSES)? Without other
 * ships' causes a pilot's body reads targets that contacts keyframe mid-window, and its client's AI ships came off
 * its tick layer (the crowd bench, ball 50: 12 AI ticks off without a keyframe), so such a client gets control rows
 */
export function pilotsFor(caps: number | undefined): boolean {
  return ((caps ?? 0) & (CAPS.PILOTS | CAPS.CAUSES)) === (CAPS.PILOTS | CAPS.CAUSES) && bodiesFor(caps);
}
