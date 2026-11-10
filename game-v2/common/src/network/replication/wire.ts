/**
 * @contract network.replication.wire
 * owns:       ship motion's rows on the wire: keyframe and control-row packing, and the aim's quantization for a step
 * needs:      common/ships (ReplicaMode, ReplicaControls, FlightBody), sim/input (simAim, simAimQ), network/cursorState
 * invariants: bit-packed and base frames decode to the same snapshot — common/src/network/packed/packedCodec.test.ts
 *             a keyframe's tail round-trips (cargo, dock, dodge, jump lock) — common/src/sim/jumpLock.test.ts
 * extend:     a new keyframe field is appended to packKeyframe / unpackKeyframe and needs npm run wire:bump
 */

/**
 * Ship motion on the wire (see ships/replica.ts). A snapshot carries:
 *
 *   ships  keyframes, only for ships a client is new to or that left the
 *          path their controls predicted:
 *          [id, mode, x, y, vx, vy, angle, angVel, jump, jumpScale, bits, q, cargo?, station?, ox?, oy?, dodge?, dodgeDir?, jumpAimQ?, jumpTo?]
 *          (cargo, the hold's mass, goes when it's set or the ship is docked or
 *          has dodged; station -1 when it isn't docked but a Burst Strafer's
 *          counter and way follow; a charging jump's lock, flight.ts FlightBody
 *          jumpAim/jumpTo, last: its heading's aim step and the distance asked)
 *   ctl    control changes since the last snapshot, per ship:
 *          [id, tb, dq, tb, dq, ...]  where tb = bits × 8 + ticksAgo
 *          (ticksAgo counts back from the snapshot's tick: the step at that tick
 *          used them; one of 7 or more goes as tb = bits × 8 + 7, then ticksAgo)
 *          or, for the common case of the aim moving tick after tick with the
 *          same buttons held, [-1 - id, tb, dq, dq, dq, ...]: one change per tick
 *          from ticksAgo on (packControlRow). The first aim goes as the step
 *          from the aim the client already has (its keyframe's or last change's:
 *          both ends keep it), each later one as the change in that step from
 *          the one before (a smooth sweep's steps are nearly equal), each
 *          wrapped to ±4096.
 *
 * q is the aim angle in the 13-bit cursor quantization; a pilot's arrives as a
 * float32 (the input encoding), so it's rounded the same way here.
 */

import { ReplicaMode, type ReplicaControls, type FlightBody } from '../../ships/index.js';
import { simAim, simAimQ } from '../../sim/input.js';
import { quantizeCursorAngle, dequantizeCursorAngle } from '../cursorState.js';

export type KeyframeRow = number[];
export type ControlRow = number[];

/** The aim angle a step uses, from its quantized form */
export function replicaAngle(mode: ReplicaMode, q: number): number {
  const a = dequantizeCursorAngle(q);
  return mode === ReplicaMode.Player ? Math.fround(a) : a;
}

export function quantizeReplicaAngle(a: number): number {
  return quantizeCursorAngle(a);
}

export interface Keyframe {
  id: number;
  mode: ReplicaMode;
  body: FlightBody;
  ctl: ReplicaControls;
  q: number;
  /** Docked: the station entity and the offset from it */
  dock?: { station: number; ox: number; oy: number };
}

export function packKeyframe(k: Keyframe): KeyframeRow {
  const b = k.body;
  const row = [k.id, k.mode, b.x, b.y, b.vx, b.vy, b.angle, b.angVel, b.jump ?? 0, b.jumpScale ?? 1, k.ctl.bits, k.q];
  const dodge = !!(b.dodge || b.dodgeDir);
  const lock = b.jumpAim !== undefined;
  if (k.dock || b.cargo || dodge || lock) row.push(b.cargo ?? 0);
  if (k.dock) row.push(k.dock.station, Math.round(k.dock.ox * 100) / 100, Math.round(k.dock.oy * 100) / 100);
  else if (dodge || lock) row.push(-1, 0, 0);
  // (The Burst Strafer's counter and the way it last dodged: ships/features/strafer)
  if (dodge || lock) row.push(b.dodge ?? 0, b.dodgeDir ?? 0);
  // (A charging jump's lock: its heading as its aim step (it is on the aim grid: flight.ts) and the distance asked)
  if (lock) row.push(simAimQ(b.jumpAim!), b.jumpTo ?? 0);
  return row;
}

export function unpackKeyframe(r: KeyframeRow): Keyframe {
  const mode = r[1] as ReplicaMode;
  return {
    id: r[0], mode,
    body: { x: r[2], y: r[3], vx: r[4], vy: r[5], angle: r[6], angVel: r[7], jump: r[8], jumpScale: r[9], ...(r[12] ? { cargo: r[12] } : {}), ...(r[16] ? { dodge: r[16] } : {}), ...(r[17] ? { dodgeDir: r[17] } : {}), ...(r.length > 19 ? { jumpAim: simAim(r[18]), jumpTo: r[19] } : {}) },
    ctl: { bits: r[10], targetAngle: replicaAngle(mode, r[11]) },
    q: r[11],
    dock: r.length > 13 && r[13] >= 0 ? { station: r[13], ox: r[14], oy: r[15] } : undefined,
  };
}

const AIM_Q = 8192;
const stepQ = (from: number, to: number) => ((to - from) % AIM_Q + AIM_Q + AIM_Q / 2) % AIM_Q - AIM_Q / 2;
const addQ = (q: number, d: number) => ((q + d) % AIM_Q + AIM_Q) % AIM_Q;

/**
 * A ship's control changes as a row; events are [ticksAgo, bits, q] oldest
 * first, `base` the aim the client has for it already.
 */
export function packControlRow(id: number, events: [number, number, number][], base: number): ControlRow {
  const steps = events.map(([, , q], i) => stepQ(i ? events[i - 1][2] : base, q));
  // (each step after the first as its change from the one before)
  const dq = steps.map((d, i) => (i ? stepQ(steps[i - 1], d) : d));
  const tb = (t: number, b: number) => (t < 7 ? [b * 8 + t] : [b * 8 + 7, t]);
  const run = events.length > 1 && events.every(([t, b], i) => i === 0 || (t === events[i - 1][0] - 1 && b === events[0][1]));
  if (run) return [-1 - id, ...tb(events[0][0], events[0][1]), ...dq];
  return [id, ...events.flatMap(([t, b], i) => [...tb(t, b), dq[i]])];
}

/** Whose row it is */
export function controlRowId(row: ControlRow): number {
  return row[0] < 0 ? -1 - row[0] : row[0];
}

/** The other way: the events, from the aim the client had */
export function unpackControlRow(row: ControlRow, base: number): [number, number, number][] {
  const events: [number, number, number][] = [];
  let q = base, step = 0, n = 0;
  let i = 1;
  // (the first step as it is, each later one as the change from the one before: packControlRow)
  const next = (v: number) => { step = n++ ? addQ(step + AIM_Q / 2, v) - AIM_Q / 2 : v; return step; };
  const tb = (): [number, number] => {
    const v = row[i++];
    return [v % 8 === 7 ? row[i++] : v % 8, Math.floor(v / 8)];
  };
  if (row[0] < 0) {
    const [t, b] = tb();
    for (let k = 0; i < row.length; k++) { q = addQ(q, next(row[i++])); events.push([t - k, b, q]); }
    return events;
  }
  while (i < row.length) {
    const [t, b] = tb();
    q = addQ(q, next(row[i++]));
    events.push([t, b, q]);
  }
  return events;
}
