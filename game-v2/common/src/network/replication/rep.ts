/**
 * What the client's replica set keeps of each ship besides its stepped states (ShipReplicaSet.ts), and the small
 * helpers its parts share (the debris world's steps, the drawn pose's smoothing). Internal to network/replication/.
 */

import type { ReplicaMode, FlightBody } from '../../ships/index.js';
import type { StateRing } from '../../sim/ring.js';
import type { ReplicaState } from '../../sim/c-replicaState.js';
import type { CtlChangeInputs } from '../../sim/d-sources.js';

/** The window of stepped states kept per ship (the ring holds HISTORY + 1 ticks) */
export const HISTORY = 240;

/** A correction the drawn pose blends in (pose.ts fixWeight) */
export interface Fix { t: number; s: number; dx: number; dy: number; da: number }

export interface Rep {
  mode: ReplicaMode;
  dock?: { station: number; ox: number; oy: number };
  /** Control changes not yet folded into a stepped state: tick → [bits, q] */
  events: Map<number, [number, number]>;
  /** Its input source over `events` (assumed: held between rows), made on first step */
  src?: CtlChangeInputs;
  /** The latest keyframe's tick (nothing before it can change) */
  kf: number;
  /** The newest aim it was sent (control rows give aims as steps from it) */
  q: number;
  /** The tick it was last drawn at (pose; undefined: not yet) */
  drawn?: number;
  /**
   * Keyframes that moved it off the path it was being drawn on, for pose to blend: at the keyframe's tick t the old
   * path was off by (dx, dy, da) (old less new). From s (the tick it was drawn at when the keyframe came, if that
   * was before t - 1) the drawn path bends onto the keyframe by t; otherwise (it came late) the correction eases
   * out after t, over SMOOTH_TICKS.
   */
  fixes?: Fix[];
  /** Where pose last drew it, before any bending (its path as it was then) */
  raw?: { t: number; x: number; y: number; angle: number };
  /** Its path was stepped again (control rows, decisions, causes for ticks already drawn) since: pose eases the change out */
  moved?: boolean;
}

export const cloneBody = (b: FlightBody): FlightBody => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, angle: b.angle, angVel: b.angVel, jump: b.jump, jumpScale: b.jumpScale, jumpAim: b.jumpAim, jumpTo: b.jumpTo, cargo: b.cargo, dodge: b.dodge, dodgeDir: b.dodgeDir });

/** A path stepped again from tick t: drawn there already, pose eases the change out */
export function rewrote(r: Rep, t: number): void {
  if (r.raw && t <= Math.floor(r.raw.t) + 1) r.moved = true;
}

/** A ship's states from tick t on go, bar its keyframe's */
export function dropKeepingKf(ring: StateRing, id: number, r: Rep, t: number): void {
  const kf = r.kf >= t ? ring.get(id, r.kf) : undefined;
  ring.dropFrom(id, t);
  if (kf) ring.keep(r.kf, kf as ReplicaState, id);
}
